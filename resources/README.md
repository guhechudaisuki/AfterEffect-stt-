# External resources

`resources` must remain next to `Setup.exe`. The installer resolves this directory from its own executable path, never from the current working directory.

## Included runtime

The release bundle includes the official Windows x64 CPU build of `whisper.cpp` pinned to tag `b4938`. The archive is not embedded in `Setup.exe`. Its exact byte length and SHA-256 are stored in `manifest.json` and verified before extraction.

Optional GPU runtime packages can be added as new `runtimes` entries. Each package needs a unique ID, backend, architecture, entry point, license reference, exact size, and SHA-256. The CPU entry must remain available as the universal fallback, but it is not mandatory when the user installs only the AE effect-copy component. PR installation still requires at least one usable STT runtime.

## Models

No speech model is bundled. `ggml-large-v3-turbo-q5_0` is marked as the recommended download and has pinned size/SHA-256 metadata. Quick installation downloads it after the user explicitly chooses STT, selects a destination folder, and confirms; it does not scan for or reuse an existing file. Custom installation only scans or uses a user-selected existing model; it does not download automatically.

If a release manager intentionally adds a model to `models/`, set `bundled` to `true`, verify its redistribution license, and run the manifest generator. Do not publish a bundled model without legal review and an exact upstream revision.

## Voice activity detection model

Quick STT installation includes the pinned whisper.cpp Silero VAD model declared in `vadModels`. The release keeps the official file name `vad/ggml-silero-v6.2.0.bin` in the external resource bundle, verifies its exact size and SHA-256, then transactionally installs it as `%LOCALAPPDATA%\LocalWhisperSubtitles\vad\silero-vad.bin`. Custom installation does not require or replace this managed VAD file.

## Integrity workflow

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tools/generate-resource-manifest.ps1
powershell -ExecutionPolicy Bypass -File tools/generate-resource-manifest.ps1 -Check
```

The first command intentionally updates hashes and lengths for resources explicitly marked `bundled: true`; use it only during a reviewed version/source change. The second command is read-only and fails if a required file is absent or differs from the manifest. `build-fetch-resources.ps1` never updates integrity values: it accepts a download only when it matches the already pinned size and SHA-256.

The current skeleton provides SHA-256 integrity but not a detached publisher signature for `manifest.json`. Production releases should add a signed manifest and Authenticode-sign Setup before distribution.
