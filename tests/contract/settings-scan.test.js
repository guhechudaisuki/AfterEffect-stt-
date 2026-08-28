const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspace = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(workspace, "extension/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(workspace, "extension/index.html"), "utf8");
const scanner = fs.readFileSync(path.join(workspace, "extension/js/core/model-scanner.js"), "utf8");

test("model scan menu exposes only a folder scan and a full-disk scan", () => {
    assert.match(html, /data-scan="specifiedDirectory"/);
    assert.match(html, /data-scan="fullDisk"/);
    assert.doesNotMatch(html, /data-scan="(?:quick|deep|skip|specifiedFile)"/);
    assert.match(app, /function scan\(mode(?:, restoredPath)?\)/);
    assert.match(app, /mode === "fullDisk"/);
    assert.match(scanner, /mode === "fullDisk"/);
});

test("panel persists model scan configuration in a user setting.txt", () => {
    assert.match(app, /LocalWhisperSubtitles.*setting\.txt/);
    assert.match(app, /function loadSettings\(\)/);
    assert.match(app, /function saveSettings\(\)/);
    assert.match(app, /scanPath/);
    assert.match(app, /selectedModel/);
});

test("panel imports the installer-selected model on first launch", () => {
    assert.match(app, /install-state\.json/);
    assert.match(app, /installed\.modelPath/);
    assert.match(app, /scan\("specifiedDirectory", installedModelPath\)/);
});
