const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "resources/manifest.json"), "utf8"));
const domainSource = fs.readFileSync(path.join(repoRoot, "installer/Domain.cs"), "utf8");
const catalogSource = fs.readFileSync(path.join(repoRoot, "installer/ResourceCatalog.cs"), "utf8");
const engineSource = fs.readFileSync(path.join(repoRoot, "installer/InstallerEngine.cs"), "utf8");
const appSource = fs.readFileSync(path.join(repoRoot, "extension/js/app.js"), "utf8");
const generatorSource = fs.readFileSync(path.join(repoRoot, "tools/generate-resource-manifest.ps1"), "utf8");
const gitignoreSource = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");

test("resource manifest declares the pinned bundled whisper.cpp Silero VAD model", () => {
    assert.ok(Array.isArray(manifest.vadModels), "manifest.vadModels must be an array");
    const vad = manifest.vadModels.find((item) => item.recommended);
    assert.ok(vad, "recommended VAD model is missing");
    assert.equal(vad.kind, "vad-model");
    assert.equal(vad.backend, "whisper.cpp");
    assert.equal(vad.localPath, "vad/ggml-silero-v6.2.0.bin");
    assert.equal(vad.size, 885098);
    assert.equal(vad.sha256, "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987");
    assert.equal(vad.bundled, true);
    assert.equal(vad.required, false, "custom and AE-only installs must not require VAD");
    assert.match(gitignoreSource, /!resources\/vad\/ggml-silero-v6\.2\.0\.bin/,
        "the bundled VAD resource must not be excluded from source releases");
});

test("installer validates and transactionally aliases bundled VAD only for quick STT", () => {
    assert.match(domainSource, /List<ResourcePackage> vadModels/);
    assert.match(domainSource, /VadRoot = Path\.Combine\(installRoot, "vad"\)/);
    assert.match(domainSource, /ResourceValidation WhisperCppVadModel/);
    assert.match(catalogSource, /FindRecommendedVadModel\(\)/);
    assert.match(catalogSource, /EnsureUniqueIds\(manifest\.runtimes, manifest\.models, manifest\.vadModels\)/);
    assert.match(engineSource, /result\.WhisperCppVadModel = result\.Catalog\.Validate\(result\.Catalog\.FindRecommendedVadModel\(\)\)/);
    assert.match(engineSource, /options\.QuickInstall && sttRequested[\s\S]*WhisperCppVadModel[\s\S]*IsValid/);
    assert.match(engineSource, /Path\.Combine\(_paths\.VadRoot, "silero-vad\.bin"\)/);
    assert.match(engineSource, /transaction\.ReplaceFile\(inspection\.WhisperCppVadModel\.FullPath, vadModelTarget\)/);
    assert.match(domainSource, /bool installWhisperCppVadModel/);
    assert.match(domainSource, /string whisperCppVadModelSha256/);
    assert.match(engineSource, /installWhisperCppVadModel = ownsVadModel/);
    assert.match(engineSource, /bool previouslyOwnedVadModel = previousState != null && previousState\.installWhisperCppVadModel/);
    assert.match(engineSource, /bool ownsVadModel = previouslyOwnedVadModel \|\| options\.QuickInstall && sttRequested/);
    assert.match(engineSource, /string managedVadModelSha256 = previousState == null \? null : previousState\.whisperCppVadModelSha256/);
    assert.match(engineSource, /whisperCppVadModelSha256 = ownsVadModel \? managedVadModelSha256 : null/);
    assert.match(engineSource, /if \(installed != null && installed\.installWhisperCppVadModel\)[\s\S]*ResourceCatalog\.ComputeSha256\(managedVadPath\)[\s\S]*transaction\.RemoveFile\(managedVadPath\)/);
    assert.doesNotMatch(engineSource, /transaction\.RemoveDirectory\(_paths\.VadRoot\)/,
        "uninstall must preserve custom VAD files in the shared VAD directory");
    assert.match(generatorSource, /@\(\$manifest\.runtimes\) \+ @\(\$manifest\.models\) \+ \$vadEntries/);
});

test("manifest generator treats vadModels as an optional schema extension", () => {
    assert.match(generatorSource, /\$vadEntries = @\(\)/);
    assert.match(generatorSource, /if \(\$null -ne \$manifest\.vadModels\)/);
});

test("extension discovers both the managed alias and whisper.cpp official VAD filename", () => {
    assert.match(appSource, /path\.join\(managed, "silero-vad\.bin"\)/);
    assert.match(appSource, /path\.join\(managed, "ggml-silero-v6\.2\.0\.bin"\)/);
    assert.match(appSource, /path\.join\(root, "\.\.", "resources", "vad", "ggml-silero-v6\.2\.0\.bin"\)/);
});
