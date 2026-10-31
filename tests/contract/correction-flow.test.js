"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const appSource = fs.readFileSync(path.resolve(__dirname, "../../extension/js/app.js"), "utf8");
const runSource = appSource.slice(appSource.indexOf("  function runTranscription()"), appSource.indexOf("  function findVadModel()"));

async function runFlow(enabled, mode, options = {}) {
  const events = [], fields = {}, snapshots = [];
  function field(id) { return fields[id] || (fields[id] = { checked: false, hidden: true, disabled: false, value: "" }); }
  field("enableSttInput").checked = true;
  const translation = { mode, baseUrl: "https://example.invalid/v1", model: "test", apiKeyRef: "session", targetLanguages: mode === "bilingual" ? ["en", "zh"] : mode === "single" ? ["zh"] : [] };
  const state = { host: "AEFT", busy: false, selectedModel: {}, selectedUvr5Model: null, sessionApiKeys: { session: "test-key" }, range: { start: 0, end: 2 } };
  function Runner() { this.on = function () {}; }
  Runner.prototype.run = function (job, callback) {
    const index = snapshots.length;
    snapshots.push(job);
    events.push("stt" + index);
    if (job.translation.mode !== "source") events.push("legacy-translate" + index);
    const result = { status: "completed", artifacts: { json: "captions-" + index + ".json" }, sourceLanguage: { code: "en" }, warnings: [], segments: [{ id: "seg-000001", sourceText: "Original " + index, sourceLines: ["Original " + index], startMs: index * 1000, endMs: (index + 1) * 1000 }] };
    queueMicrotask(() => callback(null, result));
  };
  let finish;
  const complete = new Promise((resolve, reject) => { finish = (error, _host, summary) => error ? reject(error) : resolve(summary); });
  const context = { state, root: "extension", Runner, byId: field, selectedRuntime: () => ({ engine: "fake" }),
    translationSettings: () => translation, correctionSettings: () => ({ enabled, allowCompletion: options.allowCompletion === true, highlightColor: "#0000ff" }),
    showDialog: (title) => { throw Error(title); }, startRunClock() {}, updateReadyState() {}, progress() {}, setText() {}, numberValue: (_name, fallback) => fallback,
    path, os: { tmpdir: () => "temp" }, tempStore: { create: () => ({ directory: "temp/export", path: (name) => "temp/export/" + name }) },
    createAudioExport: () => Promise.resolve({ sources: [{ path: "a.wav", inMs: 0, outMs: 1000, layerId: 1 }, { path: "b.wav", inMs: 1000, outMs: 2000, layerId: 2 }] }),
    findVadModel() {}, findVadPython() {}, findWhisperCppVadModel() {}, displayLanguages: () => translation.targetLanguages.length ? translation.targetLanguages : ["source"],
    fs: { writeFileSync() {} }, subtitleDisplay: require("../../extension/js/core/subtitle-display"), finishRun: finish,
    writeHostResult: (result, source) => { events.push("write" + (source.layerId - 1)); return Promise.resolve({ data: { count: result.segments.length } }); },
    llmPostprocessor: { processRecords: (records, config, key, callback) => {
      events.push("llm");
      assert.equal(records.length, 2); assert.equal(key, "test-key"); assert.equal(config.correction.enabled, true);
      queueMicrotask(() => callback(options.llmError ? Object.assign(Error("failed"), { code: "test" }) : null));
      return { cancel() {} };
    } }, Date, Promise, Error, JSON
  };
  vm.runInNewContext(runSource + "\nrunTranscription();", context);
  const summary = await complete;
  return { events, snapshots, summary };
}

for (const mode of ["source", "single", "bilingual"]) test("disabled correction keeps the original per-layer flow in " + mode + " mode, even with completion saved on", async () => {
  const run = await runFlow(false, mode, { allowCompletion: true });
  const expected = mode === "source" ? ["stt0", "write0", "stt1", "write1"] : ["stt0", "legacy-translate0", "write0", "stt1", "legacy-translate1", "write1"];
  assert.deepEqual(run.events, expected);
  assert.ok(run.snapshots.every((job) => job.translation.mode === mode));
  assert.equal(run.summary.segmentCount, 2);
});

for (const mode of ["source", "single", "bilingual"]) test("enabled correction waits for ALL selected sources and calls LLM once in " + mode + " mode", async () => {
  const run = await runFlow(true, mode);
  assert.deepEqual(run.events, ["stt0", "stt1", "llm", "write0", "write1"]);
  assert.ok(run.snapshots.every((job) => job.translation.mode === "source"));
  assert.equal(run.summary.segmentCount, 2);
});

test("LLM failure after all STT still writes every independent original subtitle task", async () => {
  const run = await runFlow(true, "bilingual", { llmError: true });
  assert.deepEqual(run.events, ["stt0", "stt1", "llm", "write0", "write1"]);
  assert.equal(run.summary.warnings[0].code, "W_LLM_POSTPROCESS_FAILED");
});
