from __future__ import print_function

import argparse
import importlib.util
import json
import os
import platform
import sys


def module_version(name):
    try:
        module = __import__(name)
        return getattr(module, "__version__", None)
    except Exception:
        return None


def build_probe():
    names = ("whisper", "faster_whisper", "ctranslate2", "torch", "transformers", "accelerate")
    modules = {}
    versions = {}
    for name in names:
        modules[name] = bool(importlib.util.find_spec(name))
        versions[name] = module_version(name) if modules[name] else None

    torch_cuda = False
    if modules["torch"]:
        try:
            import torch
            torch_cuda = bool(torch.cuda.is_available())
        except Exception:
            torch_cuda = False

    ctranslate2_cuda = False
    compute_types = []
    if modules["ctranslate2"]:
        try:
            import ctranslate2
            compute_types = list(ctranslate2.get_supported_compute_types("cpu"))
            try:
                cuda_types = list(ctranslate2.get_supported_compute_types("cuda"))
                ctranslate2_cuda = bool(cuda_types)
                for compute_type in cuda_types:
                    if compute_type not in compute_types:
                        compute_types.append(compute_type)
            except Exception:
                ctranslate2_cuda = False
        except Exception:
            compute_types = []

    return {
        "status": "ready",
        "python": sys.version,
        "arch": platform.architecture()[0],
        "modules": modules,
        "versions": versions,
        "torchCuda": torch_cuda,
        "ctranslate2Cuda": ctranslate2_cuda,
        "computeTypes": compute_types,
    }


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--json-output")
    args, _ = parser.parse_known_args()
    payload = build_probe()
    if not args.json_output:
        print(json.dumps(payload, ensure_ascii=False))
        return
    partial = args.json_output + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(partial, args.json_output)


if __name__ == "__main__":
    main()
