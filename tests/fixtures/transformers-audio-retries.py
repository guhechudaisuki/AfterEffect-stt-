"""Run the real bridge against an ASR double that consumes its input dict."""
import json
import os
import sys
import tempfile
import types
import wave

sys.path.insert(0, sys.argv[1])
import whisper_bridge

scenario = sys.argv[2]
untimed = scenario in ("untimed-region", "untimed-fallback")
partial = scenario in ("partial-tail", "partial-fallback")
timing_retry = scenario in ("untimed-quality-retry", "untimed-timing-retry")
errors = {"unrelated-error": "bad decoder configuration",
          "unrelated-keyword": "unexpected keyword argument 'another_option'",
          "invalid-condition": "condition_on_prev_tokens has an invalid value"}
calls = []
inputs = []
loaded_audio = []
samples = [0.0] * 16000
real_preprocess = None
if "--real-preprocess" in sys.argv:
    import numpy
    import torch
    if not hasattr(torch, "float8_e4m3fn"):
        torch.float8_e4m3fn = torch.float16
    if not hasattr(torch, "float8_e5m2"):
        torch.float8_e5m2 = torch.float16
    from transformers import AutomaticSpeechRecognitionPipeline

    samples = numpy.zeros(16000, dtype=numpy.float32)

    class Features:
        sampling_rate = 16000
        n_samples = 480000

        def __call__(self, values, **kwargs):
            assert values is samples
            return {"input_features": values, "num_frames": len(values) // 160}

    preprocess_host = types.SimpleNamespace(type="seq2seq_whisper", feature_extractor=Features(), torch_dtype=None)
    real_preprocess = AutomaticSpeechRecognitionPipeline.preprocess

fake_torch = types.ModuleType("torch")
fake_torch.float16 = "float16"
fake_torch.float32 = "float32"
sys.modules["torch"] = fake_torch


class Processor:
    tokenizer = object()
    feature_extractor = object()

    @classmethod
    def from_pretrained(cls, *args, **kwargs):
        return cls()


def read_audio(path):
    audio = {"raw": samples, "sampling_rate": 16000}
    loaded_audio.append(audio)
    return audio


def pipeline(*args, **kwargs):
    def recognize(audio, return_timestamps, generate_kwargs):
        inputs.append(audio)
        if "raw" not in audio or "sampling_rate" not in audio:
            raise ValueError('When passing a dictionary to AutomaticSpeechRecognitionPipeline, '
                             'the dict needs to contain a "raw" key containing the numpy array '
                             'and a "sampling_rate" key')
        assert audio["raw"] is samples
        assert audio["sampling_rate"] == 16000
        if real_preprocess is not None:
            assert list(real_preprocess(preprocess_host, audio))
        else:
            audio.pop("raw")
            audio.pop("sampling_rate")
        calls.append({"timestamps": return_timestamps, "kwargs": dict(generate_kwargs)})
        call = len(calls)
        if scenario == "unsupported-option" and call == 1:
            raise ValueError("The following model_kwargs are not used: ['condition_on_prev_tokens']")
        if scenario in ("timestamp-fallback", "combined", "untimed-fallback", "partial-fallback") and call == 1:
            raise IndexError("list index out of range")
        if scenario == "combined" and call == 2:
            raise TypeError("unexpected keyword argument 'condition_on_prev_tokens'")
        if scenario in errors:
            raise ValueError(errors[scenario])
        if untimed:
            return {"text": "ok"}
        if partial:
            return {"text": "first last", "chunks": [
                {"text": "first", "timestamp": (0.1, 0.4)},
                {"text": " last", "timestamp": (0.5, None)},
            ]}
        if timing_retry and call == 1:
            return {"text": "weak", "chunks": [{"text": "weak", "timestamp": (None, None),
                    "score": 0.2 if scenario == "untimed-quality-retry" else None}]}
        weak = scenario == "quality-retry" and call == 1
        text = "weak" if weak else "ok"
        score = None if scenario == "untimed-timing-retry" else (0.2 if weak else 0.9)
        return {"text": text, "chunks": [{"text": text, "timestamp": (0.1, 0.4), "score": score}]}
    return recognize


fake_transformers = types.ModuleType("transformers")
fake_transformers.AutoModelForSpeechSeq2Seq = Processor
fake_transformers.AutoProcessor = Processor
fake_transformers.pipeline = pipeline
sys.modules["transformers"] = fake_transformers
whisper_bridge.read_pcm_wav = read_audio

with tempfile.TemporaryDirectory(prefix="lws-audio-retry-") as root:
    audio_path = os.path.join(root, "audio.wav")
    with wave.open(audio_path, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 16000 * (2 if untimed else 1))
    request = {"modelPath": root, "audioPath": audio_path,
               "outputPath": os.path.join(root, "out.json"), "device": "cpu", "language": "en"}
    if scenario == "quality-retry" or timing_retry:
        request["decodeRegions"] = [{"startMs": 0, "endMs": 800}]
    if untimed:
        request["decodeRegions"] = [{"startMs": 1000, "endMs": 1200}]
    if scenario in errors:
        try:
            whisper_bridge.run_transformers(request)
        except ValueError as error:
            assert str(error) == errors[scenario], str(error)
        else:
            raise AssertionError("Unexpected decoder errors must propagate")
        assert len(calls) == 1
        result = {"segments": []}
    else:
        result = whisper_bridge.run_transformers(request)
        if partial:
            words = [w for s in result["segments"] for w in s["words"]]
            assert "".join(w["text"] for w in words) == "first last", result
            assert [(w["startMs"], w["endMs"]) for w in words] == [(100, 400), (500, 1000)], result
        else:
            assert [s["text"] for s in result["segments"]] == ["ok"], result
            times = (1000, 1200) if untimed else (100, 400)
            assert [(s["startMs"], s["endMs"]) for s in result["segments"]] == [times], result
        expected = {"success": 1, "unsupported-option": 2, "timestamp-fallback": 2,
                    "quality-retry": 2, "combined": 3, "untimed-region": 2,
                    "untimed-quality-retry": 2, "untimed-timing-retry": 2,
                    "untimed-fallback": 2, "partial-tail": 1, "partial-fallback": 2}[scenario]
        assert len(calls) == expected, calls
        if scenario in ("unsupported-option", "combined"):
            assert "condition_on_prev_tokens" not in calls[-1]["kwargs"]
        if scenario in ("timestamp-fallback", "combined"):
            assert calls[0]["timestamps"] == "word" and calls[-1]["timestamps"] is True
        if scenario == "quality-retry":
            assert calls[-1]["kwargs"]["num_beams"] == 8
    assert len(loaded_audio) == 1, "Retries must not reread the WAV"
    assert set(loaded_audio[0]) == {"raw", "sampling_rate"}, "Caller audio was consumed"
    assert loaded_audio[0]["raw"] is samples
    assert len({id(audio) for audio in inputs}) == len(inputs), "Each call needs a fresh dict"
    print(json.dumps({"scenario": scenario, "calls": len(calls), "passed": True}))
