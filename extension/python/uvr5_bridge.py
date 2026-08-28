from __future__ import annotations

import gc
import json
import math
import os
import shutil
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def event(percent: float | None, message: str) -> None:
    print("LWS_EVENT " + json.dumps({"phase": "separatingVocals", "percent": percent, "message": message}, ensure_ascii=False), flush=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise RuntimeError("UVR5 request path is required")
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    input_path = Path(request["inputPath"]).resolve()
    output_path = Path(request["outputPath"]).resolve()
    model_path = Path(request["modelPath"]).resolve()
    uvr_root = Path(request["uvrRoot"]).resolve()
    if not input_path.is_file() or not model_path.is_file() or not (uvr_root / "vr.py").is_file():
        raise FileNotFoundError("UVR5 input, model, or vr.py is missing")

    sys.path.insert(0, str(uvr_root))
    import numpy as np
    import soundfile as sf
    import torch
    from vr import AudioPre, AudioPreDeEcho

    data, sample_rate = sf.read(str(input_path), always_2d=True, dtype="float32")
    if not len(data):
        raise RuntimeError("UVR5 input audio is empty")
    duration = len(data) / float(sample_rate)
    chunk_seconds = max(6.0, float(request.get("chunkSeconds") or 60.0))
    overlap_seconds = max(0.0, min(chunk_seconds - 0.1, float(request.get("overlapSeconds") or 2.0)))
    step = chunk_seconds - overlap_seconds
    chunk_count = 1 if duration <= chunk_seconds else 1 + int(math.ceil((duration - chunk_seconds) / step))
    device_policy = str(request.get("devicePolicy") or "auto").lower()
    use_cuda = device_policy != "cpu" and torch.cuda.is_available()
    if device_policy in ("gpu", "cuda") and not use_cuda:
        raise RuntimeError("UVR5 was set to GPU, but CUDA is unavailable")
    device = torch.device("cuda" if use_cuda else "cpu")

    event(0, "正在加载 UVR5 模型")
    separator_class = AudioPreDeEcho if "deecho" in model_path.stem.lower() else AudioPre
    separator = separator_class(agg=10, model_path=str(model_path), device=device, is_half=use_cuda, tta=False)
    chunk_root = output_path.parent / (".uvr5-chunks-" + output_path.stem)
    shutil.rmtree(chunk_root, ignore_errors=True)
    chunk_root.mkdir(parents=True, exist_ok=True)
    pieces: list[tuple[float, object, int]] = []
    try:
        for index in range(chunk_count):
            start_seconds = index * step
            start_frame = int(round(start_seconds * sample_rate))
            end_frame = min(len(data), int(round((start_seconds + chunk_seconds) * sample_rate)))
            if end_frame <= start_frame:
                continue
            original_duration = (end_frame - start_frame) / float(sample_rate)
            chunk = data[start_frame:end_frame]
            minimum_frames = int(round(6.0 * sample_rate))
            if len(chunk) < minimum_frames:
                chunk = np.pad(chunk, ((0, minimum_frames - len(chunk)), (0, 0)))
            chunk_input = chunk_root / f"input_{index:04d}.wav"
            sf.write(str(chunk_input), chunk, sample_rate, subtype="PCM_16")
            event(index * 100.0 / chunk_count, f"人声提取 {index + 1}/{chunk_count}")
            if separator_class is AudioPreDeEcho:
                separator._path_audio_(str(chunk_input), vocal_root=None, ins_root=str(chunk_root), format="wav", is_hp3=False)
            else:
                separator._path_audio_(str(chunk_input), ins_root=None, vocal_root=str(chunk_root), format="wav", is_hp3="HP3" in model_path.stem)
            generated = chunk_root / f"vocal_{chunk_input.name}_10.wav"
            if not generated.is_file():
                raise RuntimeError(f"UVR5 did not create {generated.name}")
            stem, stem_rate = sf.read(str(generated), always_2d=True, dtype="float32")
            expected_frames = max(1, int(round(original_duration * stem_rate)))
            stem = np.nan_to_num(stem[:expected_frames])
            if len(stem) < expected_frames:
                stem = np.pad(stem, ((0, expected_frames - len(stem)), (0, 0)))
            pieces.append((start_seconds, stem, stem_rate))

        if not pieces:
            raise RuntimeError("UVR5 produced no vocal chunks")
        output_rate = pieces[0][2]
        if any(piece_rate != output_rate for _, _, piece_rate in pieces):
            raise RuntimeError("UVR5 output chunks have inconsistent sample rates")
        channels = pieces[0][1].shape[1]
        output_frames = max(1, int(round(duration * output_rate)))
        mixed = np.zeros((output_frames, channels), dtype=np.float64)
        weights = np.zeros((output_frames, 1), dtype=np.float64)
        placements = [(int(round(start_seconds * output_rate)), piece) for start_seconds, piece, _ in pieces]
        for piece_index, (begin, piece) in enumerate(placements):
            finish = min(output_frames, begin + len(piece))
            piece = piece[: finish - begin]
            blend = np.ones((len(piece), 1), dtype=np.float64)
            if piece_index > 0:
                fade = min(len(piece), max(0, placements[piece_index - 1][0] + len(placements[piece_index - 1][1]) - begin))
                if fade:
                    blend[:fade, 0] *= np.arange(1, fade + 1, dtype=np.float64) / (fade + 1)
            if piece_index + 1 < len(pieces):
                fade = min(len(piece), max(0, finish - placements[piece_index + 1][0]))
                if fade:
                    blend[-fade:, 0] *= np.arange(fade, 0, -1, dtype=np.float64) / (fade + 1)
            mixed[begin:finish] += piece * blend
            weights[begin:finish] += blend
        if np.any(weights <= 0):
            raise RuntimeError("UVR5 chunk merge left an uncovered interval")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), (mixed / weights).astype(np.float32), output_rate, subtype="PCM_16")
        event(100, "UVR5 人声提取完成")
    finally:
        shutil.rmtree(chunk_root, ignore_errors=True)
        del separator
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("LWS_EVENT " + json.dumps({"phase": "separatingVocals", "percent": None, "error": str(error)}, ensure_ascii=False), flush=True)
        raise
