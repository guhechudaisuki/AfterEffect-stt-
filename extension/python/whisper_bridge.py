from __future__ import print_function

import json
import math
import os
import sys
import tempfile
import wave

# The host deliberately launches external Python environments with -E -s.
# Put this bridge's adjacent schema module on sys.path explicitly so that
# embeddable and portable Python distributions work without PYTHONPATH.
BRIDGE_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if BRIDGE_DIRECTORY not in sys.path:
    sys.path.insert(0, BRIDGE_DIRECTORY)

from result_schema import validate_result


def event(payload):
    print("LWS_EVENT " + json.dumps(payload, ensure_ascii=False), flush=True)


def timestamp_ms(value, fallback=0):
    try:
        number = float(value)
        if not math.isfinite(number):
            return fallback
        return round(number * 1000)
    except (TypeError, ValueError):
        return fallback


def _finite_number(value, fallback=None):
    """Return a finite float without making the bridge depend on NumPy."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _segment_quality(segment, words=None):
    """Expose backend confidence signals for diagnostics and retry decisions.

    Whisper implementations use slightly different names for the same
    signals.  Keeping a small, JSON-safe quality object on every normalized
    segment lets the host inspect low-confidence/noisy regions without making
    the subtitle path depend on a particular Python backend.
    """
    segment = segment if isinstance(segment, dict) else {}
    words = words or []
    quality = {}
    aliases = {
        "avgLogprob": ("avg_logprob", "avgLogprob"),
        "noSpeechProb": ("no_speech_prob", "noSpeechProb"),
        "compressionRatio": ("compression_ratio", "compressionRatio"),
        "temperature": ("temperature",),
    }
    for output_name, names in aliases.items():
        value = None
        for name in names:
            if name in segment:
                value = _finite_number(segment.get(name))
                if value is not None:
                    break
        if value is not None:
            quality[output_name] = value
    probabilities = []
    for word in words:
        if not isinstance(word, dict):
            continue
        value = _finite_number(word.get("probability", word.get("p")))
        if value is not None:
            probabilities.append(max(0.0, min(1.0, value)))
    if probabilities:
        quality["meanWordProbability"] = sum(probabilities) / len(probabilities)
        quality["minWordProbability"] = min(probabilities)
        quality["wordCount"] = len(probabilities)
    return quality


def decode_regions(request):
    """Return explicit decode regions, accepting the new and legacy keys.

    ``decodeRegions`` describes the bounded speech units produced by an
    external VAD.  ``speechRegions`` remains accepted for requests written by
    older plugin versions.  A non-array value is treated as no region list so
    a malformed optional hint never prevents normal full-file decoding.
    """
    if not isinstance(request, dict):
        return []
    regions = request.get("decodeRegions")
    if not isinstance(regions, (list, tuple)):
        regions = request.get("speechRegions")
    return list(regions) if isinstance(regions, (list, tuple)) else []


def has_decode_regions(request):
    return bool(decode_regions(request))


def temperature_fallback_enabled(request):
    """Whether backend decoders may try a non-zero temperature."""
    if not isinstance(request, dict):
        return True
    return request.get("temperatureFallback", True) is not False


def temperature_schedule(request, default=(0.0, 0.2, 0.4)):
    """Normalize an optional temperature retry schedule.

    The first value is always clamped to zero or above.  Invalid values are
    ignored, and the returned tuple is deterministic so it can be passed to
    OpenAI Whisper/faster-whisper without leaking arbitrary JSON types.
    """
    if not temperature_fallback_enabled(request):
        return (0.0,)
    configured = request.get("temperatureFallbacks") if isinstance(request, dict) else None
    values = configured if isinstance(configured, (list, tuple)) else default
    output = []
    for value in values:
        number = _finite_number(value)
        if number is None or number < 0.0 or number > 1.0:
            continue
        rounded = round(number, 3)
        if rounded not in output:
            output.append(rounded)
    if not output:
        output = [0.0]
    if output[0] != 0.0:
        output.insert(0, 0.0)
    return tuple(output)


def decoder_beam_size(request, default=5):
    value = _finite_number(request.get("beamSize") if isinstance(request, dict) else None, default)
    return max(1, min(16, int(round(value))))


def decode_prompt(request, key="initialPrompt", maximum=2000):
    """Return one bounded prompt/hotword string or ``None``."""
    value = request.get(key) if isinstance(request, dict) else None
    if not isinstance(value, str):
        return None
    value = " ".join(value.split()).strip()
    return value[:maximum] or None


def call_with_compat(callable_obj, *args, **kwargs):
    """Call a backend while tolerating optional newer keyword arguments.

    OpenAI Whisper and faster-whisper are often installed from different
    release dates.  A quality option added by a newer release should not make
    an otherwise usable local environment fail.  On an ``unexpected keyword``
    TypeError we remove only the named optional key and retry as needed;
    genuine model/runtime TypeErrors are re-raised unchanged.
    """
    optional_keys = list(kwargs.pop("_optional_keys", ()))
    pending = dict(kwargs)
    while True:
        try:
            return callable_obj(*args, **pending)
        except TypeError as error:
            message = str(error).lower()
            if not any(
                marker in message
                for marker in ("unexpected keyword", "unexpected argument", "invalid keyword")
            ):
                raise
            unsupported = [
                key for key in optional_keys
                if key in pending and key.lower() in message
            ]
            if not unsupported:
                raise
            for key in unsupported:
                pending.pop(key, None)
                optional_keys.remove(key)


def _quality_summary(segments):
    """Build a compact aggregate quality report for the host diagnostics."""
    values = []
    low_confidence = 0
    for segment in segments or []:
        quality = segment.get("quality") if isinstance(segment, dict) else None
        if not isinstance(quality, dict):
            continue
        probability = _finite_number(quality.get("meanWordProbability"))
        if probability is not None:
            values.append(probability)
            if probability < 0.45:
                low_confidence += 1
    result = {"segmentCount": len(segments or []), "lowConfidenceSegments": low_confidence}
    if values:
        result["meanWordProbability"] = sum(values) / len(values)
        result["minWordProbability"] = min(values)
    return result


def _clamp01(value):
    number = _finite_number(value)
    if number is None:
        return None
    return max(0.0, min(1.0, number))


def _segment_quality_score(segment):
    """Return a comparable confidence score, or ``None`` when unavailable."""
    quality = segment.get("quality") if isinstance(segment, dict) else None
    if not isinstance(quality, dict):
        return None
    values = []
    probability = _clamp01(quality.get("meanWordProbability"))
    if probability is not None:
        values.append((probability, 0.65))
    avg_logprob = _finite_number(quality.get("avgLogprob"))
    if avg_logprob is not None:
        # Whisper log probabilities are normally in roughly [-2.5, 0].
        values.append((_clamp01((avg_logprob + 2.5) / 2.5), 0.20))
    no_speech = _clamp01(quality.get("noSpeechProb"))
    if no_speech is not None:
        values.append((1.0 - no_speech, 0.10))
    compression = _finite_number(quality.get("compressionRatio"))
    if compression is not None:
        values.append((_clamp01(1.0 - max(0.0, compression - 2.4) / 2.0), 0.05))
    if not values:
        return None
    weight = sum(item[1] for item in values)
    return sum(item[0] * item[1] for item in values) / weight


def _quality_retry_needed(segments):
    """Detect an unusually weak bounded decode without penalising clean text."""
    if not segments:
        return True
    inspected = 0
    weak = 0
    for segment in segments:
        quality = segment.get("quality") if isinstance(segment, dict) else None
        if not isinstance(quality, dict):
            continue
        inspected += 1
        probability = _finite_number(quality.get("meanWordProbability"))
        avg_logprob = _finite_number(quality.get("avgLogprob"))
        no_speech = _finite_number(quality.get("noSpeechProb"))
        compression = _finite_number(quality.get("compressionRatio"))
        if (
            probability is not None and probability < 0.45
            or avg_logprob is not None and avg_logprob < -1.35
            or no_speech is not None and no_speech > 0.70
            or compression is not None and compression > 2.80
        ):
            weak += 1
    if not inspected:
        return False
    return weak >= max(1, int(math.ceil(inspected * 0.5)))


def _candidate_quality(segments):
    scores = [score for score in (_segment_quality_score(segment) for segment in segments or []) if score is not None]
    if not scores:
        return None
    return sum(scores) / len(scores)


def _prefer_quality_candidate(primary, retry):
    """Choose a retry only when it has measurable, strictly better quality."""
    primary_segments = primary or []
    retry_segments = retry or []
    if not retry_segments:
        return primary_segments
    if not primary_segments:
        return retry_segments
    primary_score = _candidate_quality(primary_segments)
    retry_score = _candidate_quality(retry_segments)
    if primary_score is None:
        return retry_segments if retry_score is not None else primary_segments
    if retry_score is None:
        return primary_segments
    # Require a small margin so numerical noise does not replace a stable pass.
    return retry_segments if retry_score >= primary_score + 0.03 else primary_segments


def normalize_segments(segments):
    output = []
    for index, segment in enumerate(segments or []):
        if not isinstance(segment, dict):
            continue
        words = []
        segment_start_ms = timestamp_ms(segment.get("start", 0))
        segment_end_ms = timestamp_ms(segment.get("end", 0))
        previous_word_start_ms = None
        previous_word_end_ms = None
        max_word_end_ms = segment_end_ms
        for word_index, word in enumerate(segment.get("words") or []):
            start_ms = timestamp_ms(word.get("start", 0))
            end_ms = timestamp_ms(word.get("end", 0), start_ms)
            if previous_word_start_ms is not None:
                start_ms = max(start_ms, previous_word_start_ms)
            if previous_word_end_ms is not None:
                start_ms = max(start_ms, previous_word_end_ms)
            end_ms = max(end_ms, start_ms)
            words.append({
                "id": "w-%d-%d" % (index, word_index),
                "text": word.get("word") or word.get("text") or "",
                "startMs": start_ms,
                "endMs": end_ms,
                "probability": word.get("probability"),
            })
            previous_word_start_ms = start_ms
            previous_word_end_ms = end_ms
            max_word_end_ms = max(max_word_end_ms, end_ms)
        if words:
            segment_start_ms = min(segment_start_ms, words[0]["startMs"])
            segment_end_ms = max(segment_end_ms, max_word_end_ms)
        normalized = {
            "id": "raw-%d" % index,
            "startMs": segment_start_ms,
            "endMs": max(segment_end_ms, segment_start_ms),
            "text": segment.get("text") or "",
            "words": words,
        }
        quality = _segment_quality(segment, words)
        if quality:
            normalized["quality"] = quality
        output.append(normalized)
    return output


def normalize_faster_segments(segments, id_prefix="raw"):
    """Materialize faster-whisper's lazy segments with word quality data."""
    normalized = []
    previous_word_end_ms = None
    for index, segment in enumerate(segments):
        words = []
        for word_index, word in enumerate(segment.words or []):
            start_ms = round(float(word.start or 0) * 1000)
            end_ms = round(float(word.end or 0) * 1000)
            if previous_word_end_ms is not None:
                start_ms = max(start_ms, previous_word_end_ms)
            end_ms = max(end_ms, start_ms)
            words.append({
                "id": "w-%d-%d" % (index, word_index),
                "text": word.word or "",
                "startMs": start_ms,
                "endMs": end_ms,
                "probability": word.probability,
            })
            previous_word_end_ms = end_ms
        item = {
            "id": "%s-%d" % (id_prefix, index),
            "startMs": round(float(segment.start or 0) * 1000),
            "endMs": round(float(segment.end or 0) * 1000),
            "text": segment.text or "",
            "words": words,
        }
        quality = _segment_quality({
            "avg_logprob": getattr(segment, "avg_logprob", None),
            "no_speech_prob": getattr(segment, "no_speech_prob", None),
            "compression_ratio": getattr(segment, "compression_ratio", None),
            "temperature": getattr(segment, "temperature", None),
        }, words)
        if quality:
            item["quality"] = quality
        normalized.append(item)
    return normalized


def normalize_speech_regions(regions, duration_ms, merge_gap_ms=180):
    """Normalize VAD spans and keep them as hard transcription fences."""
    duration_ms = max(0, int(round(_finite_number(duration_ms, 0.0) or 0.0)))
    merge_gap_ms = max(0, int(round(_finite_number(merge_gap_ms, 180.0) or 0.0)))
    values = []
    for region in regions or []:
        if not isinstance(region, dict):
            continue
        try:
            start_value = region.get("startMs")
            if start_value is None:
                start_value = float(region.get("start") or 0) * 1000
            end_value = region.get("endMs")
            if end_value is None:
                end_value = float(region.get("end") or 0) * 1000
            start = float(start_value)
            end = float(end_value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end):
            continue
        start = max(0, min(int(round(start)), duration_ms))
        end = max(0, min(int(round(end)), duration_ms))
        if end > start:
            values.append((start, end))
    values.sort()
    merged = []
    merge_gap = max(0, int(merge_gap_ms))
    for start, end in values:
        if merged and start <= merged[-1][1] + merge_gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def region_clips(audio_path, regions, output_directory, padding_ms=240, merge_gap_ms=180):
    """Yield isolated region WAVs; callers must remove each returned path."""
    with wave.open(audio_path, "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        duration_ms = int(round(frame_count * 1000.0 / float(sample_rate or 16000)))
        normalized = normalize_speech_regions(regions, duration_ms, merge_gap_ms=merge_gap_ms)
        padding = max(0, int(padding_ms))
        for region_index, (start_ms, end_ms) in enumerate(normalized):
            clip_start_ms = max(0, start_ms - padding)
            clip_end_ms = min(duration_ms, end_ms + padding)
            first_frame = int(round(clip_start_ms * sample_rate / 1000.0))
            last_frame = int(round(clip_end_ms * sample_rate / 1000.0))
            source.setpos(max(0, min(frame_count, first_frame)))
            frames = source.readframes(max(0, last_frame - first_frame))
            handle, clip_path = tempfile.mkstemp(prefix="lws-vad-%03d-" % region_index, suffix=".wav", dir=output_directory)
            os.close(handle)
            with wave.open(clip_path, "wb") as clip:
                clip.setnchannels(channels)
                clip.setsampwidth(sample_width)
                clip.setframerate(sample_rate)
                clip.writeframes(frames)
            yield region_index, clip_path, clip_start_ms, start_ms, end_ms


def wav_duration_ms(audio_path):
    """Read a WAV duration without importing an audio framework."""
    with wave.open(audio_path, "rb") as source:
        return int(round(source.getnframes() * 1000.0 / float(source.getframerate() or 16000)))


def shift_region_segments(segments, offset_ms, region_start_ms, region_end_ms, region_index):
    """Map one independent decode back to the source timeline."""
    output = []
    for local_index, segment in enumerate(segments or []):
        local_start = int(segment.get("startMs", 0))
        local_end = int(segment.get("endMs", local_start))
        raw_shifted_start = local_start + offset_ms
        raw_shifted_end = local_end + offset_ms
        if raw_shifted_end <= region_start_ms or raw_shifted_start >= region_end_ms:
            # Context padding may contain speech from a neighbouring region.
            # Do not clamp that speech onto this region's edge as a zero-length
            # duplicate subtitle.
            continue
        shifted_start = raw_shifted_start
        shifted_end = raw_shifted_end
        shifted_start = max(region_start_ms, min(region_end_ms, shifted_start))
        shifted_end = max(shifted_start, min(region_end_ms, shifted_end))
        words = []
        for word_index, word in enumerate(segment.get("words") or []):
            raw_word_start = int(word.get("startMs", shifted_start - offset_ms)) + offset_ms
            raw_word_end = int(word.get("endMs", raw_word_start - offset_ms)) + offset_ms
            if raw_word_end <= region_start_ms or raw_word_start >= region_end_ms:
                continue
            word_start = raw_word_start
            word_end = raw_word_end
            word_start = max(shifted_start, min(shifted_end, word_start))
            word_end = max(word_start, min(shifted_end, word_end))
            words.append({
                "id": "w-%d-%d-%d" % (region_index, local_index, word_index),
                "text": word.get("text") or "",
                "startMs": word_start,
                "endMs": word_end,
                "probability": word.get("probability"),
                "vadRegionId": "vad-%d" % region_index,
            })
        if segment.get("words") and not words:
            continue
        if not segment.get("text") and not words:
            continue
        normalized = {
            "id": "raw-%d-%d" % (region_index, local_index),
            "startMs": shifted_start,
            "endMs": shifted_end,
            "text": segment.get("text") or "",
            "words": words,
            "vadRegionId": "vad-%d" % region_index,
        }
        quality = segment.get("quality")
        if isinstance(quality, dict) and quality:
            # Copy only JSON-friendly scalar values.  This keeps arbitrary
            # backend objects from crossing the process boundary.
            normalized["quality"] = {
                str(key): value
                for key, value in quality.items()
                if isinstance(key, str)
                and isinstance(value, (int, float, str, bool))
            }
        output.append(normalized)
    return output


def transcribe_regions(request, decode_region):
    """Decode VAD regions independently while reusing the loaded model."""
    regions = decode_regions(request)
    if not regions:
        return decode_region(request["audioPath"], 0, 0, None, None)
    output = []
    language = None
    with wave.open(request["audioPath"], "rb") as source:
        duration_ms = int(round(source.getnframes() * 1000.0 / float(source.getframerate() or 16000)))
    # New requests use 240 ms of acoustic context so consonants cut close to a
    # VAD edge remain recognizable.  Preserve the legacy 50 ms default only
    # when an older caller supplies ``speechRegions`` without ``decodeRegions``;
    # once it opts into the new key it receives the improved default.
    default_padding_ms = 240 if isinstance(request.get("decodeRegions"), (list, tuple)) else 50
    padding_value = request.get("speechRegionPaddingMs", default_padding_ms)
    padding_ms = int(round(_finite_number(padding_value, 240.0) or 0.0))
    padding_ms = max(0, min(2000, padding_ms))
    merge_gap_value = request.get(
        "speechRegionMergeGapMs",
        request.get("decodeRegionMergeGapMs", 180),
    )
    merge_gap_ms = int(round(_finite_number(merge_gap_value, 180.0) or 0.0))
    merge_gap_ms = max(0, min(2000, merge_gap_ms))
    for region_index, clip_path, offset_ms, start_ms, end_ms in region_clips(
        request["audioPath"],
        regions,
        os.path.dirname(request["outputPath"]),
        padding_ms,
        merge_gap_ms=merge_gap_ms,
    ):
        try:
            decoded = decode_region(clip_path, region_index, offset_ms, start_ms, end_ms)
            if decoded.get("language") and not language:
                language = decoded.get("language")
            output.extend(shift_region_segments(decoded.get("segments") or [], offset_ms, start_ms, end_ms, region_index))
        finally:
            try:
                os.remove(clip_path)
            except OSError:
                pass
        processed = min(duration_ms, end_ms)
        event({"phase": "transcribing", "processedMs": processed})
    output.sort(key=lambda item: (item["startMs"], item["endMs"]))
    return {"segments": output, "language": language}


def segment_timestamp_chunks(result, language, fallback_duration_ms=None):
    """Convert Transformers chunks into the bridge's timed format.

    Some Transformers releases omit timestamps for every token on short or
    low-SNR clips.  The old bridge returned a zero-length segment in that case,
    which was subsequently clamped away at the VAD boundary.  Supplying the
    bounded clip duration gives that text a safe local interval; the caller
    still clamps it to the original VAD region before it reaches the host.
    """
    result = result if isinstance(result, dict) else {}
    fallback_segments = []
    for chunk in result.get("chunks") or []:
        timestamp = chunk.get("timestamp") or ()
        if len(timestamp) != 2 or timestamp[0] is None or timestamp[1] is None:
            continue
        text = chunk.get("text") or ""
        if not text.strip():
            continue
        fallback_segments.append({
            "start": timestamp[0],
            "end": timestamp[1],
            "text": text,
            "words": [{"word": text, "start": timestamp[0], "end": timestamp[1]}],
        })
    if fallback_segments:
        return {"segments": normalize_segments(fallback_segments), "language": language if language not in (None, "", "auto") else None}
    text = result.get("text") or ""
    if not str(text).strip():
        return {"segments": [], "language": language if language not in (None, "", "auto") else None}
    duration = _finite_number(fallback_duration_ms, 0.0) or 0.0
    # ``fallback_duration_ms`` is intentionally optional for callers that do
    # not know the bounded clip length.  A tiny positive interval is still
    # preferable to a zero-length segment, which the host validator rejects.
    duration = max(1.0, duration) / 1000.0
    return {
        "segments": normalize_segments([{"start": 0, "end": duration, "text": text, "words": []}]),
        "language": language if language not in (None, "", "auto") else None,
    }


def validate_request(request, request_path):
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    if request.get("engine") not in ("openai-whisper", "faster-whisper", "transformers-whisper"):
        raise ValueError("unsupported Python engine")
    model_path = request.get("modelPath")
    audio_path = request.get("audioPath")
    output_path = request.get("outputPath")
    if not isinstance(model_path, str) or not isinstance(audio_path, str) or not isinstance(output_path, str):
        raise ValueError("modelPath, audioPath and outputPath are required")
    if request["engine"] == "openai-whisper" and not os.path.isfile(model_path):
        raise ValueError("OpenAI Whisper model must be an existing local .pt file")
    if request["engine"] == "faster-whisper" and not os.path.isdir(model_path):
        raise ValueError("faster-whisper model must be an existing local directory")
    if request["engine"] == "transformers-whisper" and not os.path.isdir(model_path):
        raise ValueError("Transformers Whisper model must be an existing local directory")
    if not os.path.isfile(audio_path):
        raise ValueError("audio input must be an existing local file")
    job_directory = os.path.realpath(os.path.dirname(request_path))
    output_parent = os.path.realpath(os.path.dirname(output_path))
    if output_parent != job_directory:
        raise ValueError("outputPath must remain inside the job directory")


def run_openai(request):
    import whisper
    temperature_values = temperature_schedule(request)
    beam_size = decoder_beam_size(request)
    initial_prompt = decode_prompt(request)
    event({"phase": "loadingModel", "percent": 0})
    model = whisper.load_model(request["modelPath"], device=request["device"])
    event({"phase": "loadingModel", "percent": 100})
    event({"phase": "transcribing", "percent": None, "processedMs": 0})
    def decode(path, _region_index, _offset_ms, _start_ms, _end_ms):
        # A VAD-bounded clip is known to contain speech.  Whisper's default
        # no-speech gate is tuned for an untrimmed recording and can discard a
        # quiet/noisy utterance before word timestamps are produced.  Relax it
        # only for bounded regions; unbounded full-file decoding keeps the
        # conservative default to avoid hallucinating on silence.
        bounded_region = _start_ms is not None and _end_ms is not None
        no_speech_threshold = 0.95 if bounded_region else 0.60
        result = call_with_compat(
            model.transcribe,
            path,
            language=None if request.get("language") in (None, "auto") else request["language"],
            task="transcribe",
            word_timestamps=True,
            beam_size=beam_size,
            # Preserve decoder context for a full-file pass; independent VAD
            # clips are reset so text cannot leak across utterance boundaries.
            condition_on_previous_text=not bounded_region,
            # OpenAI Whisper accepts a temperature schedule and performs
            # fallback decoding internally when a pass is low confidence.
            temperature=temperature_values if len(temperature_values) > 1 else temperature_values[0],
            no_speech_threshold=no_speech_threshold,
            logprob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            temperature_increment_on_fallback=None,
            initial_prompt=initial_prompt,
            fp16=request["device"] == "cuda",
            verbose=False,
            _optional_keys=("temperature_increment_on_fallback", "compression_ratio_threshold", "initial_prompt"),
        )
        normalized = normalize_segments(result.get("segments") or [])
        # A bounded region with weak decoder diagnostics is usually a low-SNR
        # or clipped utterance. Retry once with a wider beam and relaxed gates,
        # then keep the better-scoring candidate. Empty results are included;
        # clean regions never pay this second model call.
        if bounded_region and temperature_fallback_enabled(request) and _quality_retry_needed(normalized):
            retry = call_with_compat(
                model.transcribe,
                path,
                language=None if request.get("language") in (None, "auto") else request["language"],
                task="transcribe",
                word_timestamps=True,
                beam_size=min(16, beam_size + 3),
                condition_on_previous_text=not bounded_region,
                temperature=temperature_values[1] if len(temperature_values) > 1 else 0.2,
                no_speech_threshold=0.99 if bounded_region else 0.75,
                logprob_threshold=-2.0,
                compression_ratio_threshold=3.0,
                temperature_increment_on_fallback=None,
                initial_prompt=initial_prompt,
                fp16=request["device"] == "cuda",
                verbose=False,
                _optional_keys=("temperature_increment_on_fallback", "compression_ratio_threshold", "initial_prompt"),
            )
            retry_normalized = normalize_segments(retry.get("segments") or [])
            selected = _prefer_quality_candidate(normalized, retry_normalized)
            if selected is retry_normalized and retry_normalized:
                result = retry
            normalized = selected
        if not normalized and str(result.get("text") or "").strip():
            # A few OpenAI Whisper forks return only ``text`` when timestamp
            # extraction is unavailable. Preserve that text over silently
            # dropping the whole VAD region; the bounded interval is a safe
            # fallback and the host can mark it as estimated timing.
            if _start_ms is not None and _end_ms is not None:
                fallback_duration_ms = max(1, int(_end_ms) - int(_start_ms))
            else:
                fallback_duration_ms = wav_duration_ms(path)
            normalized = normalize_segments([{
                "start": 0,
                "end": fallback_duration_ms / 1000.0,
                "text": result.get("text") or "",
                "words": [],
            }])
        return {"segments": normalized, "language": result.get("language")}
    result = transcribe_regions(request, decode)
    result["engine"] = {
        "name": "openai-whisper",
        "device": request["device"],
        "quality": _quality_summary(result.get("segments") or []),
    }
    return result


def run_faster(request):
    from faster_whisper import WhisperModel
    temperature_values = temperature_schedule(request)
    beam_size = decoder_beam_size(request)
    initial_prompt = decode_prompt(request)
    hotwords = decode_prompt(request, key="hotwords")
    event({"phase": "loadingModel", "percent": 0})
    compute_type = request.get("computeType") or ("float16" if request["device"] == "cuda" else "int8")
    model = WhisperModel(
        request["modelPath"],
        device=request["device"],
        device_index=int(request.get("deviceIndex") or 0),
        compute_type=compute_type,
    )
    event({"phase": "loadingModel", "percent": 100})
    event({"phase": "transcribing", "percent": None, "processedMs": 0})
    def decode(path, _region_index, _offset_ms, _start_ms, _end_ms):
        bounded_region = _start_ms is not None and _end_ms is not None
        segments, info = call_with_compat(
            model.transcribe,
            path,
            language=None if request.get("language") in (None, "auto") else request["language"],
            word_timestamps=True,
            beam_size=beam_size,
            condition_on_previous_text=not bounded_region,
            # faster-whisper accepts one scalar temperature per call; the
            # bridge performs the fallback retry explicitly below.
            temperature=temperature_values[0],
            no_speech_threshold=0.95 if bounded_region else 0.60,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            initial_prompt=initial_prompt,
            hotwords=hotwords,
            vad_parameters={"min_silence_duration_ms": 350, "speech_pad_ms": 120},
            vad_filter=not has_decode_regions(request) and bool(request.get("vad", True)),
            _optional_keys=("no_speech_threshold", "log_prob_threshold", "compression_ratio_threshold", "condition_on_previous_text", "initial_prompt", "hotwords"),
        )
        normalized = normalize_faster_segments(segments)
        if bounded_region and temperature_fallback_enabled(request) and _quality_retry_needed(normalized):
            # The external FSMN VAD has already established a speech region;
            # retry once without an additional decoder gate when a quiet/noisy
            # region has weak diagnostics. The lazy first generator was fully
            # consumed by normalize_faster_segments before this point.
            retry_segments, retry_info = call_with_compat(
                model.transcribe,
                path,
                language=None if request.get("language") in (None, "auto") else request["language"],
                word_timestamps=True,
                beam_size=min(16, beam_size + 3),
                condition_on_previous_text=not bounded_region,
                temperature=temperature_values[1] if len(temperature_values) > 1 else 0.2,
                no_speech_threshold=0.99 if bounded_region else 0.75,
                log_prob_threshold=-2.0,
                compression_ratio_threshold=3.0,
                initial_prompt=initial_prompt,
                hotwords=hotwords,
                vad_filter=False,
                _optional_keys=("no_speech_threshold", "log_prob_threshold", "compression_ratio_threshold", "condition_on_previous_text", "initial_prompt", "hotwords"),
            )
            retry_normalized = normalize_faster_segments(retry_segments, id_prefix="raw-retry")
            selected = _prefer_quality_candidate(normalized, retry_normalized)
            if selected is retry_normalized and retry_normalized:
                info = retry_info
            normalized = selected
        return {"segments": normalized, "language": getattr(info, "language", None)}
    result = transcribe_regions(request, decode)
    result["engine"] = {
        "name": "faster-whisper",
        "device": request["device"],
        "computeType": compute_type,
        "quality": _quality_summary(result.get("segments") or []),
    }
    return result


def read_pcm_wav(audio_path):
    try:
        import numpy
    except Exception:
        raise RuntimeError("Transformers Whisper requires numpy in the selected Python environment")
    with wave.open(audio_path, "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    if sample_width != 2:
        raise ValueError("Transformers Whisper requires 16-bit PCM WAV audio")
    if sample_rate != 16000:
        raise ValueError("Transformers Whisper requires 16 kHz WAV audio")
    samples = numpy.frombuffer(frames, dtype=numpy.int16).astype(numpy.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape((-1, channels)).mean(axis=1)
    return {"raw": samples, "sampling_rate": sample_rate}


def run_transformers(request):
    import torch

    # Transformers 4.43 accesses these dtypes unconditionally while PyTorch
    # versions before 2.1 do not expose them. The selected model is FP16, so
    # local aliases keep this worker compatible without modifying the user's
    # shared Python environment.
    if not hasattr(torch, "float8_e4m3fn"):
        torch.float8_e4m3fn = torch.float16
    if not hasattr(torch, "float8_e5m2"):
        torch.float8_e5m2 = torch.float16
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

    use_cuda = request["device"] == "cuda"
    device_index = int(request.get("deviceIndex") or 0)
    dtype = torch.float16 if use_cuda else torch.float32
    language = request.get("language")
    # VAD clips are already hard-bounded. A non-zero pipeline stride makes
    # Whisper's timestamp merge path index an absent overlap chunk on short
    # clips (the source of "list index out of range" on sub-second speech).
    pipeline_stride = (0, 0) if has_decode_regions(request) else (5, 5)
    generate_kwargs = {"task": "transcribe"}
    # Per-call decoding below resets context for independent VAD regions while
    # retaining it for an unbounded full-file pass. Older Transformers builds
    # may reject condition_on_prev_tokens; the compatibility wrapper removes
    # it only when that backend explicitly reports the option as unsupported.
    generate_kwargs.update({"num_beams": 5, "temperature": 0.0})
    if language not in (None, "", "auto"):
        generate_kwargs["language"] = language
    event({"phase": "loadingModel", "percent": 0})
    placement = "cpu"
    if use_cuda and request.get("allowHybrid"):
        try:
            from accelerate.utils import get_max_memory
        except Exception as exc:
            raise RuntimeError("当前 Python 缺少 accelerate，无法进行 CPU+GPU 混合计算: %s" % exc)
        if not torch.cuda.is_available():
            raise RuntimeError("当前 Python 的 CUDA 不可用，无法进行 CPU+GPU 混合计算")
        free_bytes, total_bytes = torch.cuda.mem_get_info(device_index)
        reserve_bytes = max(1536 * 1024 * 1024, int(total_bytes * 0.25))
        gpu_budget = max(256 * 1024 * 1024, int(free_bytes - reserve_bytes))
        model_size_bytes = int(request.get("modelSizeBytes") or 0)
        if model_size_bytes > 0:
            gpu_budget = min(gpu_budget, max(256 * 1024 * 1024, int(model_size_bytes * 0.75)))
        max_memory = get_max_memory()
        max_memory[device_index] = gpu_budget
        offload_folder = os.path.join(os.path.dirname(request["outputPath"]), "model-offload")
        os.makedirs(offload_folder, exist_ok=True)
        event({"phase": "loadingModel", "percent": 0, "device": "cuda", "placement": "hybrid", "gpuBudgetMiB": round(gpu_budget / 1048576)})
        processor = AutoProcessor.from_pretrained(request["modelPath"], local_files_only=True)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            request["modelPath"],
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
            local_files_only=True,
            device_map="auto",
            max_memory=max_memory,
            offload_folder=offload_folder,
            offload_state_dict=True,
        )
        device_map = getattr(model, "hf_device_map", {}) or {}
        devices = set(str(value) for value in device_map.values())
        gpu_name = "cuda:%d" % device_index
        has_gpu = gpu_name in devices or str(device_index) in devices or "cuda" in devices
        has_cpu = "cpu" in devices or "disk" in devices
        placement = "hybrid" if has_gpu and has_cpu else ("cuda" if has_gpu else "cpu")
        recognizer = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            device=None,
            chunk_length_s=30,
            stride_length_s=pipeline_stride,
        )
    else:
        device = device_index if use_cuda else -1
        processor = AutoProcessor.from_pretrained(request["modelPath"], local_files_only=True)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            request["modelPath"],
            torch_dtype=dtype,
            local_files_only=True,
        )
        recognizer = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            device=device,
            torch_dtype=dtype,
            model_kwargs={"local_files_only": True},
            chunk_length_s=30,
            stride_length_s=pipeline_stride,
        )
        placement = "cuda" if use_cuda else "cpu"
    event({"phase": "loadingModel", "percent": 100, "device": request["device"], "placement": placement})
    event({"phase": "transcribing", "percent": None, "processedMs": 0})
    def recognize(audio, timestamp_mode, bounded_region, overrides=None):
        call_kwargs = dict(generate_kwargs)
        call_kwargs["condition_on_prev_tokens"] = not bounded_region
        if isinstance(overrides, dict):
            call_kwargs.update(overrides)
        try:
            return recognizer(
                audio,
                return_timestamps=timestamp_mode,
                generate_kwargs=call_kwargs,
            )
        except (TypeError, ValueError) as error:
            message = str(error).lower()
            if "condition_on_prev_tokens" not in message and not any(
                marker in message
                for marker in (
                    "unexpected keyword",
                    "unexpected argument",
                    "invalid keyword",
                    "model_kwargs are not used",
                )
            ):
                raise
            compatible_kwargs = dict(call_kwargs)
            compatible_kwargs.pop("condition_on_prev_tokens", None)
            return recognizer(
                audio,
                return_timestamps=timestamp_mode,
                generate_kwargs=compatible_kwargs,
            )

    def decode(path, _region_index, _offset_ms, _start_ms, _end_ms):
        audio = read_pcm_wav(path)
        # Always request word timestamps. Segment timestamps alone lose the
        # pauses needed for accurate subtitle boundaries. A guarded fallback
        # below handles Transformers releases with the short-clip indexing bug.
        timestamp_mode = "word"
        bounded_region = _start_ms is not None and _end_ms is not None
        try:
            result = recognize(audio, timestamp_mode, bounded_region)
        except IndexError as error:
            # Transformers 4.43 can return fewer token timestamps than token
            # IDs for short Whisper clips (tokenizer._decode_asr then raises
            # "list index out of range"). Retry with segment timestamps; VAD
            # already gives us a hard utterance fence, so this remains safely
            # timed and avoids dropping the entire subtitle task.
            if "list index out of range" not in str(error):
                raise
            result = recognize(audio, True, bounded_region)
            fallback_duration_ms = (
                max(1, int(_end_ms) - int(_start_ms))
                if _start_ms is not None and _end_ms is not None
                else wav_duration_ms(path)
            )
            return segment_timestamp_chunks(result, language, fallback_duration_ms)
        def timed_segments(payload):
            chunks = payload.get("chunks") or []
            words = []
            for chunk in chunks:
                timestamp = chunk.get("timestamp") or ()
                if len(timestamp) != 2 or timestamp[0] is None or timestamp[1] is None:
                    continue
                words.append({
                    "word": chunk.get("text") or "",
                    "start": timestamp[0],
                    "end": timestamp[1],
                    "probability": chunk.get("score", chunk.get("probability")),
                })
            if not words:
                return []
            return normalize_segments([{
                "start": words[0]["start"],
                "end": words[-1]["end"],
                "text": payload.get("text") or "",
                "words": words,
            }])

        normalized = timed_segments(result)
        if bounded_region and temperature_fallback_enabled(request) and _quality_retry_needed(normalized):
            try:
                retry_result = recognize(
                    audio,
                    timestamp_mode,
                    True,
                    {"num_beams": 8, "temperature": 0.2},
                )
                retry_normalized = timed_segments(retry_result)
            except (IndexError, TypeError, ValueError):
                retry_result = None
                retry_normalized = []
            selected = _prefer_quality_candidate(normalized, retry_normalized)
            if selected is retry_normalized and retry_normalized:
                result = retry_result
            normalized = selected
        if normalized:
            return {
                "segments": normalized,
                "language": language if language not in (None, "", "auto") else None,
            }
        fallback_duration_ms = (
            max(1, int(_end_ms) - int(_start_ms))
            if _start_ms is not None and _end_ms is not None
            else wav_duration_ms(path)
        )
        return segment_timestamp_chunks(result, language, fallback_duration_ms)
    result = transcribe_regions(request, decode)
    result["engine"] = {
        "name": "transformers-whisper",
        "device": request["device"],
        "placement": placement,
        "computeType": "float16" if use_cuda else "float32",
        "quality": _quality_summary(result.get("segments") or []),
    }
    return result


def safe_error(exc, request):
    message = str(exc)
    for key in ("modelPath", "audioPath", "outputPath"):
        value = request.get(key) if isinstance(request, dict) else None
        if value:
            message = message.replace(value, "<%s>" % key)
    return message[:500]


def main():
    request_path = os.path.realpath(sys.argv[1])
    with open(request_path, "r", encoding="utf-8-sig") as handle:
        request = json.load(handle)
    output_path = request.get("outputPath")
    job_directory = os.path.realpath(os.path.dirname(request_path))
    if not isinstance(output_path, str) or os.path.realpath(os.path.dirname(output_path)) != job_directory:
        raise ValueError("outputPath must remain inside the job directory")
    try:
        validate_request(request, request_path)
        if request["engine"] == "openai-whisper":
            result = run_openai(request)
        elif request["engine"] == "faster-whisper":
            result = run_faster(request)
        else:
            result = run_transformers(request)
        result = validate_result(result)
    except Exception as exc:
        text = str(exc)
        result = {
            "error": {
                "message": safe_error(exc, request),
                "type": type(exc).__name__,
                "oom": "out of memory" in text.lower() or "cublas_status_alloc_failed" in text.lower(),
            }
        }
    partial = output_path + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False)
    os.replace(partial, output_path)


if __name__ == "__main__":
    main()
