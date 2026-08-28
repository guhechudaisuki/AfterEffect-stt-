"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "extension/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "extension/js/app.js"), "utf8");
const aeHost = fs.readFileSync(path.join(root, "extension/jsx/AEFT/host.jsx"), "utf8");

test("AE effect copy is the primary visible tool and has its own command", () => {
  const effectTool = html.indexOf('id="effectCopyDetails"');
  const transcriptionOptions = html.indexOf('id="transcriptionDetails"');
  assert.ok(effectTool >= 0, "effect-copy tool is missing");
  assert.match(html.slice(Math.max(0, effectTool - 180), effectTool + 100), /<details[^>]*\bopen\b/);
  assert.ok(effectTool < transcriptionOptions, "effect copy must appear before optional transcription");
  assert.match(html, /id="applyEffectsButton"[^>]*>[\s\S]*?<span>复制特效<\/span>/);
});

test("effect copy command is independent from Whisper transcription", () => {
  const start = app.indexOf("function applyEffects()");
  const end = app.indexOf("function bindUi()", start);
  const command = app.slice(start, end);
  assert.match(command, /hostCall\("ae\.modules\.copy"/);
  assert.doesNotMatch(command, /runTranscription|selectedModel|selectedRuntime|Whisper|STT/);
  assert.match(app, /applyEffectsButton"\)\.addEventListener\("click", applyEffects\)/);
});

test("effect copy exposes an AEP source selector and routes selected AEP layers to the effect source recorder", () => {
  assert.match(html, /id="chooseEffectAepButton"/);
  assert.match(app, /function chooseEffectAep\(\)/);
  assert.match(app, /effectSourceRecorder\.setItems\(items\)/);
  assert.match(app, /step === "effectComps"/);
  assert.match(app, /step === "effectLayers"/);
  assert.match(app, /ae\.comp\.listTextLayers/);
  assert.doesNotMatch(app, /ae\.comp\.listLayers/);
  assert.doesNotMatch(aeHost, /register\("ae\.comp\.listLayers"/);
});

test("AEP effect source path filters defensively to text layers only", () => {
  assert.match(app, /function useAepAsEffectSource\(selected\)/);
  assert.match(app, /\(selected \|\| \[\]\)\.filter\(function \(layer\) \{ return layer && layer\.isText === true; \}\)/);
  assert.match(app, /effectSourceRecorder\.setItems\(items\)/);
  assert.match(aeHost, /register\("ae\.comp\.listTextLayers"/);
  assert.doesNotMatch(app, /ae\.comp\.listLayers/);
});

test("effect property tree handles both inline and file host transports", () => {
  assert.match(app, /data\.transport === "inline"/);
  assert.match(app, /data = data\.value/);
  assert.match(app, /data\.transport === "jsonFile"/);
  assert.match(app, /effectTreeLoading/);
  assert.match(app, /Promise\.all\(items\.map/);
  assert.match(app, /LWS Source Group/);
});

test("STT and UVR5 are explicit optional controls", () => {
  assert.match(html, /id="enableSttInput"[^>]*type="checkbox"[^>]*checked/);
  assert.match(html, /id="enableUvr5Input"[^>]*type="checkbox"/);
  assert.match(html, /id="uvr5ScanMenu"/);
  assert.match(html, /id="uvr5ModelSelect"/);
  assert.match(app, /uvr5Enabled/);
  assert.match(app, /enableSttInput/);
});
