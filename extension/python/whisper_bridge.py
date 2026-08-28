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


def normalize_segments(segments):
    output = []
    for index, segment in enumerate(segments):
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
        output.append({
            "id": "raw-%d" % index,
            "startMs": segment_start_ms,
            "endMs": max(segment_end_ms, segment_start_ms),
            "text": segment.get("text") or "",
            "words": words,
        })
    return output


def normalize_speech_regions(regions, duration_ms, merge_gap_ms=180):
    """Normalize VAD spans and keep them as hard transcription fences."""
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


def region_clips(audio_path, regions, output_directory, padding_ms=50):
    """Yield isolated region WAVs; callers must remove each returned path."""
    with wave.open(audio_path, "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        duration_ms = int(round(frame_count * 1000.0 / float(sample_rate or 16000)))
        normalized = normalize_speech_regions(regions, duration_ms)
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


def shift_region_segments(segments, offset_ms, region_start_ms, region_end_ms, region_index):
    """Map one independent decode back to the source timeline."""
    output = []
    for local_index, segment in enumerate(segments or []):
        local_start = int(segment.get("startMs", 0))
        local_end = int(segment.get("endMs", local_start))
        shifted_start = local_start + offset_ms
        shifted_end = local_end + offset_ms
        shifted_start = max(region_start_ms, min(region_end_ms, shifted_start))
        shifted_end = max(shifted_start, min(region_end_ms, shifted_end))
        words = []
        for word_index, word in enumerate(segment.get("words") or []):
            word_start = int(word.get("startMs", shifted_start - offset_ms)) + offset_ms
            word_end = int(word.get("endMs", word_start - offset_ms)) + offset_ms
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
        if not segment.get("text") and not words:
            continue
        output.append({
            "id": "raw-%d-%d" % (region_index, local_index),
            "startMs": shifted_start,
            "endMs": shifted_end,
            "text": segment.get("text") or "",
            "words": words,
            "vadRegionId": "vad-%d" % region_index,
        })
    return output


def transcribe_regions(request, decode_region):
    """Decode VAD regions independently while reusing the loaded model."""
    regions = request.get("speechRegions") or []
    if not regions:
        return decode_region(request["audioPath"], 0, 0, None, None)
    output = []
    language = None
    with wave.open(request["audioPath"], "rb") as source:
        duration_ms = int(round(source.getnframes() * 1000.0 / float(source.getframerate() or 16000)))
    for region_index, clip_path, offset_ms, start_ms, end_ms in region_clips(
        request["audioPath"], regions, os.path.dirname(request["outputPath"]), request.get("speechRegionPaddingMs", 50)
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


def segment_timestamp_chunks(result, language):
    """Convert Transformers segment chunks into the bridge's timed format."""
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
    return {"segments": normalize_segments([{"start": 0, "end": 0, "text": text, "words": []}]) if text.strip() else [], "language": language if language not in (None, "", "auto") else None}


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
    event({"phase": "loadingModel", "percent": 0})
    model = whisper.load_model(request["modelPath"], device=request["device"])
    event({"phase": "loadingModel", "percent": 100})
    event({"phase": "transcribing", "percent": None, "processedMs": 0})
    def decode(path, _region_index, _offset_ms, _start_ms, _end_ms):
        result = model.transcribe(
            path,
            language=None if request.get("language") in (None, "auto") else request["language"],
            task="transcribe",
            word_timestamps=True,
            beam_size=5,
            condition_on_previous_text=False,
            temperature=0,
            no_speech_threshold=0.6,
            logprob_threshold=-1.0,
            fp16=request["device"] == "cuda",
            verbose=False,
        )
        return {"segments": normalize_segments(result.get("segments") or []), "language": result.get("language")}
    result = transcribe_regions(request, decode)
    result["engine"] = {"name": "openai-whisper", "device": request["device"]}
    return result


def run_faster(request):
    from faster_whisper import WhisperModel
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
        segments, info = model.transcribe(
            path,
            language=None if request.get("language") in (None, "auto") else request["language"],
            word_timestamps=True,
            beam_size=5,
            condition_on_previous_text=False,
            temperature=0.0,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 80},
            vad_filter=not bool(request.get("speechRegions")) and bool(request.get("vad", True)),
        )
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
                words.append({"id": "w-%d-%d" % (index, word_index), "text": word.word or "", "startMs": start_ms, "endMs": end_ms, "probability": word.probability})
                previous_word_end_ms = end_ms
            normalized.append({"id": "raw-%d" % index, "startMs": round(float(segment.start or 0) * 1000), "endMs": round(float(segment.end or 0) * 1000), "text": segment.text or "", "words": words})
        return {"segments": normalized, "language": getattr(info, "language", None)}
    result = transcribe_regions(request, decode)
    result["engine"] = {"name": "faster-whisper", "device": request["device"], "computeType": compute_type}
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
    pipeline_stride = (0, 0) if request.get("speechRegions") else (5, 5)
    generate_kwargs = {"task": "transcribe"}
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
    def decode(path, _region_index, _offset_ms, _start_ms, _end_ms):
        audio = read_pcm_wav(path)
        timestamp_mode = True if request.get("speechRegions") else "word"
        try:
            result = recognizer(
                audio,
                return_timestamps=timestamp_mode,
                generate_kwargs=generate_kwargs,
            )
        except IndexError as error:
            # Transformers 4.43 can return fewer token timestamps than token
            # IDs for short Whisper clips (tokenizer._decode_asr then raises
            # "list index out of range"). Retry with segment timestamps; VAD
            # already gives us a hard utterance fence, so this remains safely
            # timed and avoids dropping the entire subtitle task.
            if "list index out of range" not in str(error):
                raise
            result = recognizer(
                read_pcm_wav(path),
                return_timestamps=True,
                generate_kwargs=generate_kwargs,
            )
            return segment_timestamp_chunks(result, language)
        if timestamp_mode is True:
            return segment_timestamp_chunks(result, language)
        chunks = result.get("chunks") or []
        words = []
        for chunk in chunks:
            timestamp = chunk.get("timestamp") or ()
            if len(timestamp) != 2 or timestamp[0] is None or timestamp[1] is None:
                continue
            words.append({"word": chunk.get("text") or "", "start": timestamp[0], "end": timestamp[1]})
        if not words:
            return {"segments": [], "language": language if language not in (None, "", "auto") else None}
        return {
            "segments": normalize_segments([{
                "start": words[0]["start"],
                "end": words[-1]["end"],
                "text": result.get("text") or "",
                "words": words,
            }]),
            "language": language if language not in (None, "", "auto") else None,
        }
    result = transcribe_regions(request, decode)
    result["engine"] = {"name": "transformers-whisper", "device": request["device"], "placement": placement, "computeType": "float16" if use_cuda else "float32"}
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
