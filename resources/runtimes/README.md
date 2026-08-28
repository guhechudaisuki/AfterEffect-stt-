# Runtime packages

This directory stores external Whisper runtime archives. Runtime binaries are never embedded in Setup.

The baseline package is downloaded from the exact upstream release URL declared in `../manifest.json`. Run `tools/generate-resource-manifest.ps1` after replacing any archive. A changed hash without a matching version/source update is a release error.

CPU and GPU packages are optional installation components. They use separate manifest entries and include all redistributed dependency notices. The CPU package remains available as the universal fallback when a user chooses STT or when Vulkan/GPU is unavailable.
