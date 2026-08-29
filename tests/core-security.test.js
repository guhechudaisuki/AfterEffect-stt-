"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var EventEmitter = require("events").EventEmitter;
var http = require("http");
var fs = require("fs");
var os = require("os");
var path = require("path");
var scanner = require("../extension/js/core/model-scanner");
var matcher = require("../extension/js/core/model-runtime-matcher");
var runtimeDetector = require("../extension/js/core/runtime-detector");
var processController = require("../extension/js/core/process-controller");
var segmentUtils = require("../extension/js/core/segment-utils");
var jobSchema = require("../extension/js/core/job-schema");
var runnerModule = require("../extension/js/core/transcription-runner");
var translationClient = require("../extension/js/core/translation-client");
var whispercpp = require("../extension/js/core/whispercpp-adapter");
var hardwareProfiler = require("../extension/js/core/hardware-profiler");
var resourceManifest = require("../extension/js/core/resource-manifest");

function scan(options) {
  return new Promise(function (resolve, reject) {
    scanner.scanModels(options, function (error, result) {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function makeChild() {
  var child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = function () { child.killed = true; };
  return child;
}

test("scanner requires a GGML/GGUF header instead of trusting a model-like filename", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-magic-"));
  var valid = Buffer.alloc(32, 0);
  valid.write("lmgg", 0, "ascii");
  fs.writeFileSync(path.join(root, "ggml-valid.bin"), valid);
  fs.writeFileSync(path.join(root, "ggml-fake.bin"), Buffer.alloc(32, 7));
  fs.writeFileSync(path.join(root, "fake.gguf"), Buffer.alloc(32, 7));
  var result = await scan({ mode: "deep", roots: [root], maxDepth: 1 });
  assert.deepEqual(result.models.map(function (model) { return path.basename(model.path); }), ["ggml-valid.bin"]);
});

test("scanModels dispatches specified-path mode and reports a missing target", async function () {
  await assert.rejects(scan({ mode: "specified", specifiedPath: path.join(os.tmpdir(), "lws-no-such-model.pt") }), function (error) {
    return error && error.code === "E_SCAN_PATH_NOT_FOUND";
  });
});

test("runtime matcher handles sparse descriptors and never advertises unsupported GGUF", function () {
  var models = [{ id: "gguf", format: "gguf" }, { id: "ggml", format: "ggml-bin" }];
  var runtimes = [{ id: "cpp", status: "ready", engine: "whisper.cpp", supportedModelFormats: ["ggml-bin"] }];
  var pairs;
  assert.doesNotThrow(function () { pairs = matcher.matchModelsToRuntimes(models, runtimes, { gpu: true }); });
  assert.equal(pairs[0].compatible, false);
  assert.equal(pairs[1].compatible, true);
  assert.equal(pairs[1].recommendedDevice, "cpu");
});

test("runtime detector finds ffmpeg beside an explicitly selected Python runtime", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-ffmpeg-runtime-"));
  var python = path.join(root, "runtime", "python.exe");
  var ffmpeg = path.join(root, "runtime", "ffmpeg.exe");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "python");
  fs.writeFileSync(ffmpeg, "ffmpeg");
  try {
    var executables = runtimeDetector.findExecutables([], [python]);
    assert.ok(executables.some(function (candidate) { return path.resolve(candidate).toLowerCase() === path.resolve(ffmpeg).toLowerCase(); }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("hardware scheduler tolerates missing GPU arrays and selects CPU", function () {
  var choice = hardwareProfiler.chooseDevice({ devices: ["cuda", "cpu"] }, { sizeBytes: 1024 }, { gpu: true, cpu: { recommendedThreads: 2 } }, "auto");
  assert.equal(choice.device, "cpu");
});

test("hardware profiler checks standard Windows NVIDIA SMI paths", function () {
  var source = fs.readFileSync(path.join(__dirname, "../extension/js/core/hardware-profiler.js"), "utf8");
  assert.match(source, /C:\\\\Windows\\\\System32\\\\nvidia-smi\.exe/);
  assert.match(source, /C:\\\\Windows\\\\Sysnative\\\\nvidia-smi\.exe/);
});

test("Transformers runtime advertises CPU+GPU mixed placement when Accelerate is available", function () {
  var descriptors = runtimeDetector.descriptorsFromPythonProbe("C:\\Python\\python.exe", {
    status: "ready",
    python: "3.11",
    arch: "64bit",
    modules: { torch: true, transformers: true, accelerate: true },
    torchCuda: true
  }, "C:\\plugin\\whisper_bridge.py");
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].capabilities.hybridDevice, true);
  var choice = hardwareProfiler.chooseDevice(descriptors[0], { sizeBytes: 8 * 1024 * 1024 * 1024 }, {
    gpu: true,
    gpus: [{ index: 0, freeMiB: 4096 }],
    cpu: { recommendedThreads: 2 }
  }, "auto");
  assert.equal(choice.device, "cuda");
  assert.equal(choice.hybrid, true);
  var forcedGpu = hardwareProfiler.chooseDevice(descriptors[0], { sizeBytes: 8 * 1024 * 1024 * 1024 }, {
    gpu: true,
    gpus: [{ index: 0, freeMiB: 4096 }],
    cpu: { recommendedThreads: 2 }
  }, "gpu");
  assert.equal(forcedGpu.device, "cpu");
  assert.equal(forcedGpu.hybrid, undefined);
});

test("a four-gigabyte GPU selects mixed placement for large-v3-turbo-sized Transformers weights", function () {
  var runtime = { engine: "transformers-whisper", devices: ["cpu", "cuda"], capabilities: { hybridDevice: true } };
  var choice = hardwareProfiler.chooseDevice(runtime, { sizeBytes: 1617824864 }, {
    gpu: true,
    gpus: [{ index: 0, freeMiB: 3900 }],
    cpu: { recommendedThreads: 8 }
  }, "auto");
  assert.equal(choice.device, "cuda");
  assert.equal(choice.hybrid, true);
});

test("resource package resolver rejects absolute and escaping paths", function () {
  var manifest = { runtimes: [{ id: "escape", localPath: "..\\outside.zip" }, { id: "absolute", localPath: "C:\\\\outside.zip" }, { id: "ok", localPath: "runtimes\\cpu.zip" }], models: [] };
  assert.equal(resourceManifest.resolvePackage(manifest, "C:\\resources", "escape"), null);
  assert.equal(resourceManifest.resolvePackage(manifest, "C:\\resources", "absolute"), null);
  assert.equal(resourceManifest.resolvePackage(manifest, "C:\\resources", "ok").path, path.resolve("C:\\resources", "runtimes\\cpu.zip"));
});

test("one Python probe creates separate OpenAI and faster-whisper runtimes", function () {
  var descriptors = runtimeDetector.descriptorsFromPythonProbe("C:\\Python\\python.exe", {
    status: "ready",
    python: "3.11",
    arch: "64bit",
    modules: { whisper: true, faster_whisper: true, ctranslate2: true, torch: true },
    torchCuda: true,
    ctranslate2Cuda: true,
    computeTypes: ["int8", "float16"]
  }, "C:\\plugin\\whisper_bridge.py");
  assert.deepEqual(descriptors.map(function (runtime) { return runtime.engine; }), ["openai-whisper", "faster-whisper"]);
  assert.equal(descriptors[0].bridgePath, "C:\\plugin\\whisper_bridge.py");
  assert.deepEqual(descriptors[1].supportedModelFormats, ["ctranslate2"]);
});

test("Conda root discovery searches one level beneath a fixed drive", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-conda-root-"));
  var conda = path.join(root, "yun", "Miniconda");
  fs.mkdirSync(conda, { recursive: true });
  try {
    var roots = runtimeDetector.findCondaRoots([root]);
    assert.ok(roots.some(function (candidate) { return path.resolve(candidate) === path.resolve(conda); }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Hugging Face Whisper directory has a distinct model format", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-hf-model-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ model_type: "whisper" }));
  fs.writeFileSync(path.join(root, "preprocessor_config.json"), "{}");
  fs.writeFileSync(path.join(root, "tokenizer.json"), "{}");
  fs.writeFileSync(path.join(root, "model.safetensors"), Buffer.from([1]));
  var output = { models: [], warningKeys: {}, warnings: [] };
  try {
    scanner.inspectHuggingFaceWhisper(root, ["config.json", "preprocessor_config.json", "tokenizer.json", "model.safetensors"], {}, output);
    assert.equal(output.models.length, 1);
    assert.equal(output.models[0].format, "huggingface-whisper");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("process controller keeps arguments discrete, forces shell false, and strips secret environment", async function () {
  var captured;
  var child = makeChild();
  await new Promise(function (resolve, reject) {
    processController.spawnProcess("C:\\Tool Path\\runner.exe", ["a&b", "x|y"], {
      cwd: "C:\\Temp Path",
      env: { PATH: "C:\\Windows", API_KEY: "secret", PYTHONPATH: "bad", USERPROFILE: "C:\\User" },
      spawn: function (command, args, options) {
        captured = { command: command, args: args, options: options };
        process.nextTick(function () { child.emit("close", 0, null); });
        return child;
      }
    }, function (error) {
      if (error) reject(error);
      else resolve();
    });
  });
  assert.deepEqual(captured.args, ["a&b", "x|y"]);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.env.API_KEY, undefined);
  assert.equal(captured.options.env.PYTHONPATH, undefined);
  assert.equal(captured.options.env.PATH, "C:\\Windows");
});

test("process controller reports direct cancellation as E_JOB_CANCELED exactly once", async function () {
  var child = makeChild();
  var callbackCount = 0;
  await new Promise(function (resolve, reject) {
    var controller = processController.spawnProcess("runner.exe", [], {
      killGraceMs: 5,
      spawn: function () { return child; }
    }, function (error) {
      callbackCount += 1;
      try {
        assert.equal(error.code, "E_JOB_CANCELED");
        resolve();
      } catch (assertionError) { reject(assertionError); }
    });
    controller.cancel();
    child.emit("close", null, "SIGTERM");
    child.emit("error", new Error("late error"));
  });
  assert.equal(callbackCount, 1);
});

test("wordless segments still split sentences and mark estimated timing", function () {
  var cues = segmentUtils.formatSegments([{ id: "raw-0", startMs: 0, endMs: 900, text: "One. Two? 三。", words: [] }], 5000, { maxCharsPerLine: 0 });
  assert.deepEqual(cues.map(function (cue) { return cue.sourceText; }), ["One.", "Two?", "三。"]);
  assert.equal(cues[0].startMs, 5000);
  assert.equal(cues[2].endMs, 5900);
  assert.ok(cues.every(function (cue) { return cue.timingSource === "estimated" && cue.warnings[0].code === "W_TIMING_ESTIMATED"; }));
});

test("capacity splitting uses word timestamps when natural word boundaries exist", function () {
  var raw = [{ id: "raw-0", startMs: 0, endMs: 1200, text: "one two three", words: [
    { text: "one", startMs: 0, endMs: 250 },
    { text: " two", startMs: 300, endMs: 650 },
    { text: " three", startMs: 700, endMs: 1200 }
  ] }];
  var cues = segmentUtils.formatSegments(raw, 0, { maxCharsPerLine: 5, maxLines: 1 });
  assert.deepEqual(cues.map(function (cue) { return cue.sourceText; }), ["one", "two", "three"]);
  assert.deepEqual(cues.map(function (cue) { return [cue.startMs, cue.endMs]; }), [[0, 250], [300, 650], [700, 1200]]);
  assert.ok(cues.every(function (cue) { return cue.timingSource === "wordTimestamp"; }));
});

test("segment normalization clamps overlapping backend word timestamps", function () {
  var cues = segmentUtils.formatSegments([{ id: "raw-0", startMs: 0, endMs: 1200, text: "one two", words: [
    { text: "one", startMs: 0, endMs: 800 },
    { text: "two", startMs: 400, endMs: 500 }
  ] }], 0, { maxCharsPerLine: 0, maxLines: null });
  assert.equal(cues.length, 1);
  assert.ok(cues[0].words[1].startMs >= cues[0].words[0].endMs);
  assert.ok(cues[0].words[1].endMs >= cues[0].words[1].startMs);
});

test("job schema rejects plaintext translation credentials", function () {
  var job = makeJob();
  job.translation.apiKey = "must-not-enter-job-json";
  assert.throws(function () { jobSchema.validateJob(job); }, function (error) {
    return error && error.code === "E_INVALID_REQUEST";
  });
});

test("runner resolves apiKeyRef in memory and retries a fake GPU OOM once on CPU", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-runner-"));
  var secret = "test-secret-never-persist";
  var devices = [];
  var resolvedRef = null;
  var translatedKey = null;
  var fakeAdapter = {
    run: function (_, request, __, callback) {
      devices.push(request.device);
      process.nextTick(function () {
        if (request.device === "cuda") {
          var oom = new Error("GPU OOM");
          oom.code = "E_PROCESS_EXIT";
          oom.details = { oom: true };
          callback(oom);
        } else {
          callback(null, { language: "en", segments: [{ id: "raw-0", startMs: 0, endMs: 300, text: "Hello.", words: [{ text: "Hello.", startMs: 0, endMs: 300 }] }] });
        }
      });
      return { cancel: function () {} };
    }
  };
  var runner = new runnerModule.TranscriptionRunner({
    tempRoot: root,
    runtimeDescriptor: { id: "fake", engine: "whisper.cpp", executable: "fake.exe", devices: ["cpu", "cuda"] },
    modelDescriptor: { id: "fake-model", path: "model.bin", format: "ggml-bin", sizeBytes: 1024 },
    hardware: { gpu: true, gpus: [{ index: 0, freeMiB: 8192 }], cpu: { recommendedThreads: 2 } },
    audioPreprocessor: { prepareAudio: function (_, output, __, ___, callback) { process.nextTick(function () { callback(null, output); }); return { cancel: function () {} }; } },
    adapters: { "whisper.cpp": fakeAdapter },
    getApiKey: function (ref, callback) { resolvedRef = ref; process.nextTick(function () { callback(null, secret); }); },
    translationClient: {
      translateSegments: function (cues, config, apiKey, callback) {
        translatedKey = apiKey;
        cues[0].translations = { "zh-CN": { text: "你好。", lines: ["你好。"], status: "completed" } };
        process.nextTick(function () { callback(null, cues); });
        return { cancel: function () {} };
      }
    }
  });
  var result = await new Promise(function (resolve, reject) {
    runner.run(makeJob(), function (error, value) { if (error) reject(error); else resolve(value); });
  });
  assert.deepEqual(devices, ["cuda", "cpu"]);
  assert.equal(result.engine.fellBackFromGpu, true);
  assert.equal(resolvedRef, "credential-1");
  assert.equal(translatedKey, secret);
  assert.equal(JSON.stringify(result).indexOf(secret), -1);
  assert.equal(fs.readFileSync(result.artifacts.json, "utf8").indexOf(secret), -1);
});

test("runner skips Whisper when the prepared audio has no waveform", async function () {
  var adapterRuns = 0;
  var runner = new runnerModule.TranscriptionRunner({
    tempRoot: fs.mkdtempSync(path.join(os.tmpdir(), "lws-silent-")),
    runtimeDescriptor: { id: "fake", engine: "whisper.cpp", executable: "fake.exe", devices: ["cpu"] },
    modelDescriptor: { id: "fake-model", path: "model.bin", format: "ggml-bin", sizeBytes: 1024 },
    hardware: { gpu: false, gpus: [], cpu: { recommendedThreads: 2 } },
    audioPreprocessor: {
      prepareAudio: function (_, output, __, ___, callback) { process.nextTick(function () { callback(null, output); }); return { cancel: function () {} }; },
      hasAudioSignal: function () { return false; }
    },
    adapters: { "whisper.cpp": { run: function (_, __, ___, callback) { adapterRuns += 1; callback(null, { language: "en", segments: [] }); return { cancel: function () {} }; } } }
  });
  var result = await new Promise(function (resolve, reject) {
    runner.run({
      schemaVersion: 1,
      jobId: "silent-job",
      audioInput: { path: "input.wav", timelineInMs: 0, timelineOutMs: 1000, alreadyTrimmed: true, layerId: 42 },
      model: { id: "fake-model", path: "model.bin", format: "ggml-bin" },
      runtime: { id: "fake", engine: "whisper.cpp", executable: "fake.exe" },
      transcription: { language: "auto", devicePolicy: "auto", wordTimestamps: true, vad: true },
      segmentation: { mode: "smart", maxCharsPerLine: 0, maxLines: null },
      translation: { mode: "source", targetLanguages: [] }
    }, function (error, value) { if (error) reject(error); else resolve(value); });
  });
  assert.equal(adapterRuns, 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.warnings[0].code, "W_AUDIO_NO_SIGNAL");
});

test("runner sends UVR5 output into STT when cleaning is enabled", async function () {
  var calls = [];
  var runner = new runnerModule.TranscriptionRunner({
    tempRoot: fs.mkdtempSync(path.join(os.tmpdir(), "lws-uvr5-run-")),
    runtimeDescriptor: { id: "fake", engine: "whisper.cpp", executable: "fake.exe", devices: ["cpu"] },
    modelDescriptor: { id: "fake-model", path: "model.bin", format: "ggml-bin", sizeBytes: 1024 },
    hardware: { gpu: false, gpus: [], cpu: { recommendedThreads: 2 } },
    audioPreprocessor: {
      prepareAudio: function (_, output, __, options, callback) { calls.push(["prepare", output, options.targetSampleRate || 16000, options.targetChannels || 1]); process.nextTick(function () { callback(null, output); }); return { cancel: function () {} }; },
      hasAudioSignal: function () { return true; },
      detectSpeechRegions: function () { return [{ startMs: 0, endMs: 300 }]; }
    },
    uvr5Preprocessor: {
      separate: function (input, output, descriptor, options, callback) { calls.push(["uvr5", input, output, descriptor.path]); process.nextTick(function () { callback(null, output); }); return { cancel: function () {} }; }
    },
    speechVad: { detect: function (audioPath, descriptor, store, options, callback) { calls.push(["vad", audioPath]); process.nextTick(function () { callback(null, [{ startMs: 0, endMs: 300 }]); }); return { cancel: function () {} }; } },
    adapters: { "whisper.cpp": { run: function (_, request, __, callback) { calls.push(["stt", request.audioPath]); process.nextTick(function () { callback(null, { language: "en", segments: [{ id: "raw-0", startMs: 0, endMs: 300, text: "Hello.", words: [{ text: "Hello.", startMs: 0, endMs: 300 }] }] }); }); return { cancel: function () {} }; } } }
  });
  var result = await new Promise(function (resolve, reject) {
    runner.run({
      schemaVersion: 1,
      jobId: "uvr5-job",
      audioInput: { path: "input.wav", timelineInMs: 0, timelineOutMs: 1000, alreadyTrimmed: true },
      preprocessing: { uvr5Enabled: true, uvr5Model: { path: "HP2_all_vocals.pth", uvrRoot: "uvr-root", pythonExecutable: "python.exe" } },
      model: { id: "fake-model", path: "model.bin", format: "ggml-bin" },
      runtime: { id: "fake", engine: "whisper.cpp", executable: "fake.exe" },
      transcription: { language: "auto", devicePolicy: "auto", wordTimestamps: true, vad: true },
      segmentation: { mode: "smart", maxCharsPerLine: 0, maxLines: null },
      translation: { mode: "source", targetLanguages: [] }
    }, function (error, value) { if (error) reject(error); else resolve(value); });
  });
  assert.equal(calls.some(function (call) { return call[0] === "uvr5"; }), true);
  assert.equal(calls.some(function (call) { return call[0] === "prepare" && /uvr5-input\.wav$/.test(call[1]) && call[2] === 44100; }), true);
  assert.equal(calls.some(function (call) { return call[0] === "uvr5" && /uvr5-input\.wav$/.test(call[1]); }), true);
  assert.equal(calls.some(function (call) { return call[0] === "stt" && /uvr5-vocal-16k\.wav$/.test(call[1]); }), true);
  assert.equal(result.engine.preprocessing.uvr5, true);
});

test("runner keeps the original waveform when VAD is only a boundary hint", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-vad-hint-"));
  var input = path.join(root, "input.wav");
  var sampleRate = 16000;
  var data = Buffer.alloc(sampleRate * 2 * 2);
  for (var sample = 0; sample < sampleRate * 2; sample += 1) {
    // A continuous low-level bed plus a quiet speech-like island.  A hard
    // VAD mask would erase the bed and any speech that the detector missed.
    var value = sample >= sampleRate * 0.75 && sample < sampleRate * 1.25 ? 2200 : 1000;
    data.writeInt16LE(value, sample * 2);
  }
  var header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(input, Buffer.concat([header, data]));
  var recognizedPath = null;
  var runner = new runnerModule.TranscriptionRunner({
    tempRoot: root,
    runtimeDescriptor: { id: "fake", engine: "whisper.cpp", executable: "fake.exe", devices: ["cpu"] },
    modelDescriptor: { id: "fake-model", path: "model.bin", format: "ggml-bin", sizeBytes: 1024 },
    hardware: { gpu: false, gpus: [], cpu: { recommendedThreads: 2 } },
    audioPreprocessor: {
      prepareAudio: function (source, output, __, ___, callback) {
        fs.copyFileSync(source, output);
        process.nextTick(function () { callback(null, output); });
        return { cancel: function () {} };
      },
      hasAudioSignal: function () { return true; },
      detectSpeechRegions: function () { return [{ startMs: 750, endMs: 1250 }]; }
    },
    adapters: {
      "whisper.cpp": {
        run: function (_, request, __, callback) {
          recognizedPath = request.audioPath;
          process.nextTick(function () {
            callback(null, { language: "en", segments: [{ id: "raw-0", startMs: 0, endMs: 300, text: "hello", words: [{ text: "hello", startMs: 0, endMs: 300 }] }] });
          });
          return { cancel: function () {} };
        }
      }
    }
  });
  var result = await new Promise(function (resolve, reject) {
    runner.run({
      schemaVersion: 1,
      jobId: "vad-hint-job",
      audioInput: { path: input, timelineInMs: 0, timelineOutMs: 2000, alreadyTrimmed: true },
      model: { id: "fake-model", path: "model.bin", format: "ggml-bin" },
      runtime: { id: "fake", engine: "whisper.cpp", executable: "fake.exe" },
      transcription: { language: "auto", devicePolicy: "auto", wordTimestamps: true, vad: true },
      segmentation: { mode: "smart", maxCharsPerLine: 0, maxLines: null },
      translation: { mode: "source", targetLanguages: [] }
    }, function (error, value) { if (error) reject(error); else resolve(value); });
  });
  assert.equal(result.status, "completed");
  assert.ok(recognizedPath);
  assert.equal(path.basename(recognizedPath), "audio.wav");
  assert.notEqual(path.basename(recognizedPath), "speech-isolated.wav");
  assert.equal(result.engine.preprocessing.speechIsolation, false);
});

test("runner fuses energy boundaries but reserves independent clips for neural VAD", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-vad-plan-"));
  var input = path.join(root, "input.wav");
  var sampleRate = 16000;
  var data = Buffer.alloc(sampleRate * 2 * 2);
  for (var sample = 0; sample < sampleRate * 2; sample += 1) data.writeInt16LE(sample >= sampleRate * 0.2 && sample < sampleRate * 0.8 ? 10000 : 0, sample * 2);
  var header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(input, Buffer.concat([header, data]));
  var requestSeen;
  var runner = new runnerModule.TranscriptionRunner({
    tempRoot: root,
    runtimeDescriptor: { id: "fake", engine: "whisper.cpp", executable: "fake.exe", devices: ["cpu"] },
    modelDescriptor: { id: "fake-model", path: "model.bin", format: "ggml-bin", sizeBytes: 1024 },
    hardware: { gpu: false, gpus: [], cpu: { recommendedThreads: 2 } },
    whispercppVadModelPath: path.join(root, "silero.bin"),
    audioPreprocessor: {
      prepareAudio: function (source, output, __, ___, callback) { fs.copyFileSync(source, output); process.nextTick(function () { callback(null, output); }); return { cancel: function () {} }; },
      hasAudioSignal: function () { return true; },
      detectSpeechRegions: function () { return [{ startMs: 1200, endMs: 1600 }]; }
    },
    speechVad: { detect: function (_, __, ___, ____, callback) { process.nextTick(function () { callback(null, [{ startMs: 200, endMs: 800 }]); }); return { cancel: function () {} }; } },
    vadDescriptor: { modelPath: path.join(root, "vad-model"), pythonExecutable: "python.exe", bridgePath: "vad.py" },
    adapters: { "whisper.cpp": { run: function (_, request, __, callback) {
      requestSeen = request;
      process.nextTick(function () { callback(null, { language: "en", segments: [{ id: "raw-0", startMs: 250, endMs: 700, text: "hello", words: [{ text: "hello", startMs: 250, endMs: 700 }] }] }); });
      return { cancel: function () {} };
    } } }
  });
  await new Promise(function (resolve, reject) {
    runner.run({
      schemaVersion: 1,
      jobId: "vad-plan-job",
      audioInput: { path: input, timelineInMs: 0, timelineOutMs: 2000, alreadyTrimmed: true },
      model: { id: "fake-model", path: "model.bin", format: "ggml-bin" },
      runtime: { id: "fake", engine: "whisper.cpp", executable: "fake.exe" },
      transcription: { language: "auto", devicePolicy: "auto", wordTimestamps: true, vad: true },
      segmentation: { mode: "smart", maxCharsPerLine: 0, maxLines: null },
      translation: { mode: "source", targetLanguages: [] }
    }, function (error) { if (error) reject(error); else resolve(); });
  });
  assert.ok(requestSeen);
  assert.equal(requestSeen.vad, false, "external VAD clip must disable a second whisper.cpp VAD");
  assert.deepEqual(requestSeen.decodeRegions, [{ startMs: 200, endMs: 800 }]);
  assert.ok(requestSeen.speechBoundaryHints.some(function (region) { return region.startMs === 1200 && region.endMs === 1600; }));
});

test("translation reuses the source language without making an HTTP request", async function () {
  var cues = [{ id: "seg-1", sourceText: "原文。", startMs: 10, endMs: 20 }];
  var result = await new Promise(function (resolve, reject) {
    translationClient.translateSegments(cues, {
      sourceLanguage: "zh",
      targetLanguages: ["zh-CN"],
      baseUrl: "http://remote-http-must-not-be-called.invalid/v1",
      model: "unused"
    }, "unused-secret", function (error, value) { if (error) reject(error); else resolve(value); });
  });
  assert.equal(result[0].translations["zh-CN"].text, "原文。");
  assert.deepEqual([result[0].startMs, result[0].endMs], [10, 20]);
});

test("translation fake HTTP preserves timing and retries one 5xx response", async function () {
  var requests = 0;
  var server = http.createServer(function (request, response) {
    requests += 1;
    var chunks = [];
    request.on("data", function (chunk) { chunks.push(chunk); });
    request.on("end", function () {
      if (requests === 1) {
        response.writeHead(500, { "Content-Type": "text/html" });
        response.end("<html>temporary gateway failure</html>");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [
        { id: "b", translations: { "zh-CN": "乙" } },
        { id: "a", translations: { "zh-CN": "甲" } }
      ] }) } }] }));
    });
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  var cues = [{ id: "a", sourceText: "A", startMs: 100, endMs: 200 }, { id: "b", sourceText: "B", startMs: 250, endMs: 400 }];
  try {
    await new Promise(function (resolve, reject) {
      translationClient.translateSegments(cues, {
        sourceLanguage: "en",
        targetLanguages: ["zh-CN"],
        baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
        model: "fake",
        maxRetries: 1,
        maxRetryDelayMs: 1
      }, "memory-only", function (error) { if (error) reject(error); else resolve(); });
    });
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
  assert.equal(requests, 2);
  assert.deepEqual(cues.map(function (cue) { return [cue.startMs, cue.endMs]; }), [[100, 200], [250, 400]]);
  assert.deepEqual(cues.map(function (cue) { return cue.translations["zh-CN"].text; }), ["甲", "乙"]);
});

test("whisper.cpp only emits flags confirmed by its probe", function () {
  assert.throws(function () {
    whispercpp.buildArgs({ flags: {}, engine: "whisper.cpp" }, { modelPath: "m", audioPath: "a", language: "auto", threads: 2, device: "cpu", vad: true }, "out");
  }, function (error) { return error && error.code === "E_RUNTIME_INCOMPATIBLE"; });
  assert.deepEqual(whispercpp.buildArgs({ flags: { jsonFull: "-ojf", noGpu: "-ng", vad: "--vad", vadModel: "--vad-model" }, engine: "whisper.cpp" }, {
    modelPath: "m", audioPath: "a", language: "auto", threads: 2, device: "cpu", vad: true, vadModelPath: "vad.bin"
  }, "out"), ["-m", "m", "-f", "a", "-l", "auto", "-t", "2", "-ojf", "-of", "out", "-ng", "--vad", "--vad-model", "vad.bin"]);
});

test("whisper.cpp Vulkan requests pass the selected device index", function () {
  var args = whispercpp.buildArgs({
    flags: { jsonFull: "-ojf", device: "-dev" },
    engine: "whisper.cpp",
    devices: ["cpu", "vulkan"]
  }, {
    modelPath: "model.gguf",
    audioPath: "audio.wav",
    language: "auto",
    threads: 4,
    device: "vulkan",
    deviceIndex: 1,
    vad: false
  }, "out");
  assert.deepEqual(args, ["-m", "model.gguf", "-f", "audio.wav", "-l", "auto", "-t", "4", "-ojf", "-of", "out", "-dev", "1"]);
});

test("job schema accepts the explicit Vulkan GPU+CPU hybrid policy", function () {
  assert.doesNotThrow(function () {
    jobSchema.validateJob({
      jobId: "hybrid",
      audioInput: { path: "x", timelineInMs: 0, timelineOutMs: 1000 },
      model: { path: "m.gguf", format: "gguf" },
      transcription: { devicePolicy: "hybrid" },
      segmentation: { maxCharsPerLine: 0, maxLines: null },
      translation: { mode: "source", targetLanguages: [] }
    });
  });
});

test("hardware scheduler exposes Vulkan hybrid only when Vulkan is detected", function () {
  var runtime = { engine: "whisper.cpp", devices: ["cpu", "vulkan"] };
  var selected = hardwareProfiler.chooseDevice(runtime, { sizeBytes: 1024 }, { vulkan: true, gpu: false, gpus: [] }, "hybrid");
  assert.equal(selected.device, "vulkan");
  assert.equal(selected.hybrid, true);
  var unavailable = hardwareProfiler.chooseDevice(runtime, { sizeBytes: 1024 }, { vulkan: false, gpu: false, gpus: [] }, "hybrid");
  assert.equal(unavailable.device, "cpu");
  assert.equal(unavailable.available, false);
});

test("whisper.cpp probe records Vulkan device indices for hybrid scheduling", function () {
  var descriptor = runtimeDetector.parseWhisperCppProbe("C:\\whisper-cli.exe", [
    "ggml_vulkan: Found 2 Vulkan devices:",
    "ggml_vulkan: 0 = Intel(R) UHD Graphics | uma: 1",
    "ggml_vulkan: 1 = NVIDIA GeForce RTX 3050 | uma: 0",
    "usage: whisper-cli.exe"
  ].join("\n"));
  assert.deepEqual(descriptor.vulkanDevices, [
    { index: 0, name: "Intel(R) UHD Graphics" },
    { index: 1, name: "NVIDIA GeForce RTX 3050" }
  ]);
  var choice = hardwareProfiler.chooseDevice(descriptor, { sizeBytes: 1 }, { vulkan: true, gpu: false, gpus: [] }, "hybrid");
  assert.equal(choice.deviceIndex, 1);
});

test("forced GPU policy fails rather than silently using CPU", async function () {
  var runner = new runnerModule.TranscriptionRunner({
    tempRoot: fs.mkdtempSync(path.join(os.tmpdir(), "lws-gpu-")),
    runtimeDescriptor: { engine: "whisper.cpp", executable: "fake.exe", devices: ["cpu"] },
    hardware: { gpu: false, gpus: [], cpu: { recommendedThreads: 2 } }
  });
  var job = makeJob();
  job.translation = { mode: "source", targetLanguages: [] };
  job.transcription.devicePolicy = "gpu";
  var error = await new Promise(function (resolve) { runner.run(job, resolve); });
  assert.equal(error.code, "E_GPU_UNAVAILABLE");
});

test("translation cancellation destroys the active HTTP request", async function () {
  var server = http.createServer(function (_, response) {
    setTimeout(function () {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [] }));
      }
    }, 200);
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  var error;
  try {
    error = await new Promise(function (resolve) {
      var controller = translationClient.translateSegments([{ id: "a", sourceText: "A", startMs: 0, endMs: 1 }], {
        sourceLanguage: "en",
        targetLanguages: ["zh-CN"],
        baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
        model: "fake"
      }, "memory-only", function (requestError) { resolve(requestError); });
      setTimeout(function () { controller.cancel(); }, 10);
    });
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
  assert.equal(error.code, "E_JOB_CANCELED");
});

function makeJob() {
  return {
    schemaVersion: 1,
    jobId: "core-security-job",
    audioInput: { path: "input.wav", timelineInMs: 1000, timelineOutMs: 2000, alreadyTrimmed: true },
    model: { id: "fake-model", path: "model.bin", format: "ggml-bin" },
    runtime: { id: "fake", engine: "whisper.cpp", executable: "fake.exe" },
    transcription: { language: "auto", devicePolicy: "auto", wordTimestamps: true, vad: true },
    segmentation: { mode: "smart", maxCharsPerLine: 0, maxLines: null },
    translation: { mode: "single", targetLanguages: ["zh-CN"], baseUrl: "https://example.invalid/v1", model: "translator", apiKeyRef: "credential-1" }
  };
}
