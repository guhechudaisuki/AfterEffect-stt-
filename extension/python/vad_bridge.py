from __future__ import print_function

import json
import math
import os
import sys
import wave


def event(payload):
    print("LWS_EVENT " + json.dumps(payload, ensure_ascii=False), flush=True)


def duration_seconds(path):
    with wave.open(path, "rb") as source:
        return source.getnframes() / float(source.getframerate() or 16000)


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("VAD request path is required")
    with open(sys.argv[1], "r", encoding="utf-8-sig") as handle:
        request = json.load(handle)
    model_path = request.get("modelPath")
    audio_path = request.get("audioPath")
    output_path = request.get("outputPath")
    if not all(isinstance(value, str) for value in (model_path, audio_path, output_path)):
        raise ValueError("modelPath, audioPath and outputPath are required")
    if not os.path.isdir(model_path) or not os.path.isfile(audio_path):
        raise FileNotFoundError("FunASR VAD model or audio is missing")
    from funasr import AutoModel

    event({"phase": "detectingSpeech", "percent": 0})
    model = AutoModel(model=model_path, device=request.get("device") or "cpu", disable_pbar=True, disable_update=True, check_latest=False)
    result = model.generate(input=audio_path, batch_size_s=60)
    values = result[0].get("value", []) if result else []
    duration_ms = int(round(duration_seconds(audio_path) * 1000))
    regions = []
    for pair in values:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        start_ms = max(0, int(round(float(pair[0]))))
        end_ms = min(duration_ms, int(round(float(pair[1]))))
        if end_ms > start_ms:
            regions.append({"startMs": start_ms, "endMs": end_ms})
    event({"phase": "detectingSpeech", "percent": 100, "regionCount": len(regions)})
    partial = output_path + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump({"regions": regions, "engine": "funasr-fsmn-vad", "modelPath": model_path}, handle, ensure_ascii=False)
    os.replace(partial, output_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        request = {}
        try:
            with open(sys.argv[1], "r", encoding="utf-8-sig") as handle:
                request = json.load(handle)
        except Exception:
            pass
        output_path = request.get("outputPath")
        if output_path:
            partial = output_path + ".partial"
            with open(partial, "w", encoding="utf-8") as handle:
                json.dump({"error": str(exc)[:500]}, handle, ensure_ascii=False)
            os.replace(partial, output_path)
