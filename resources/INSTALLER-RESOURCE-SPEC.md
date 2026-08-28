# Installer and resource contract

## Supported scope

- Windows x64, per-user installation, no elevation.
- After Effects 2020 (17.x) and newer, and Premiere Pro 2020 (17.x) and newer.
- CEP extension target: `%APPDATA%\Adobe\CEP\extensions\com.localwhisper.subtitles`.
- Managed product data: `%LOCALAPPDATA%\LocalWhisperSubtitles`.
- `HKCU\Software\Adobe\CSXS.11\PlayerDebugMode` is written as `REG_SZ` value `1`.

Host detection uses registry locations only as candidates. A host counts as supported only after reading the product/file version from `AfterFX.exe` or `Adobe Premiere Pro.exe` and confirming major version `17` or newer.

## Transaction boundary

Extension and runtime directories are extracted to an incoming sibling directory. Existing targets are renamed to unique backup directories before the incoming directory is renamed into place. Registry and file changes keep rollback snapshots until all self-checks complete. A failed install restores the prior extension, runtime, install state, and registry values.

Uninstall removes the CEP extension, managed runtime, installed provenance files, install state, and uninstall registration. It intentionally preserves:

- all external models and paths;
- the product model directory, if a user created it;
- user settings and credentials;
- `PlayerDebugMode`, because it is shared by other unsigned CEP extensions.

## Download boundary

Custom installation performs no network download. Quick installation may download the explicitly confirmed recommended model over HTTPS to the user-selected folder, using a `.part` file and size/SHA-256 verification before atomic rename. A missing or corrupt bundled runtime blocks runtime installation with a precise integrity error.

## Release limitations

The skeleton verifies payloads with SHA-256. It does not yet verify a detached signature over `manifest.json`, Authenticode signatures, or upstream code-signing certificates. These are production release gates, not optional integrity warnings.
