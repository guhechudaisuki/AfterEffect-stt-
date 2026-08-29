"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");
var runtimeDetector = require("../extension/js/core/runtime-detector");
var whispercpp = require("../extension/js/core/whispercpp-adapter");
var processController = require("../extension/js/core/process-controller");

test("whisper.cpp probe records optional prompt, decoder and VAD controls", function () {
  var descriptor = runtimeDetector.parseWhisperCppProbe("C:\\tools\\whisper-cli.exe", [
    "whisper.cpp version 1.7",
    "--output-json-full",
    "--prompt PROMPT",
    "--carry-initial-prompt",
    "--max-context N --max-len N --best-of N --beam-size N --audio-ctx N",
    "--word-thold N --entropy-thold N --logprob-thold N --no-speech-thold N",
    "--temperature N --temperature-inc N --no-fallback --split-on-word",
    "--suppress-nst --suppress-regex REGEX --flash-attn --no-flash-attn",
    "--print-confidence --log-score",
    "--vad --vad-model FILE --vad-threshold N",
    "--vad-min-speech-duration-ms N --vad-min-silence-duration-ms N",
    "--vad-max-speech-duration-s N --vad-speech-pad-ms N --vad-samples-overlap N"
  ].join("\n"));

  assert.equal(descriptor.flags.prompt, "--prompt");
  assert.equal(descriptor.flags.carryInitialPrompt, "--carry-initial-prompt");
  assert.equal(descriptor.flags.temperature, "--temperature");
  assert.equal(descriptor.flags.temperatureInc, "--temperature-inc");
  assert.equal(descriptor.flags.vadThreshold, "--vad-threshold");
  assert.equal(descriptor.flags.vadMinSilenceDurationMs, "--vad-min-silence-duration-ms");
  assert.equal(descriptor.flags.vadSamplesOverlap, "--vad-samples-overlap");
  assert.equal(descriptor.capabilities.prompt, true);
  assert.equal(descriptor.capabilities.vadParameters, true);
  assert.equal(descriptor.capabilities.tokenProbabilities, true);
});

test("whisper.cpp probe does not infer a short flag from a longer option", function () {
  var descriptor = runtimeDetector.parseWhisperCppProbe("C:\\tools\\whisper-cli.exe", [
    "whisper.cpp",
    "--output-json-full",
    "--vad-model FILE",
    "--temperature-inc N",
    "--no-flash-attn"
  ].join("\n"));

  assert.equal(descriptor.flags.vad, false);
  assert.equal(descriptor.flags.temperature, false);
  assert.equal(descriptor.flags.flashAttn, false);
  assert.equal(descriptor.capabilities.vad, false);
});

test("whisper.cpp adapter passes only probed optional decoder and VAD values", function () {
  var runtime = {
    engine: "whisper.cpp",
    flags: {
      jsonFull: "-ojf",
      noGpu: "-ng",
      beamSize: "-bs",
      splitOnWord: "-sow",
      noSpeechThreshold: "-nth",
      logprobThreshold: "-lpt",
      temperature: "-tp",
      bestOf: "-bo",
      entropyThold: "-et",
      temperatureInc: "-tpi",
      noFallback: "-nf",
      prompt: "--prompt",
      carryInitialPrompt: "--carry-initial-prompt",
      suppressNst: "-sns",
      noFlashAttn: "-nfa",
      vad: "--vad",
      vadModel: "-vm",
      vadThreshold: "-vt",
      vadMinSpeechDurationMs: "-vspd",
      vadMinSilenceDurationMs: "-vsd",
      vadSpeechPadMs: "-vp",
      vadSamplesOverlap: "-vo"
    }
  };
  var args = whispercpp.buildArgs(runtime, {
    modelPath: "model.gguf",
    audioPath: "audio.wav",
    language: "zh",
    threads: 6,
    device: "cpu",
    decoding: {
      beamSize: 8,
      bestOf: 8,
      splitOnWord: true,
      noSpeechThreshold: 0.45,
      logprobThreshold: -1.2,
      temperature: 0,
      entropyThreshold: 2.2,
      temperatureInc: 0.2,
      initialPrompt: "角色名\n专有术语",
      carryInitialPrompt: true,
      suppressNonSpeechTokens: true,
      flashAttention: false,
      // This flag was not reported by the probe and must not be emitted.
      maxContext: 256
    },
    hotwords: "产品名, 地名",
    temperatureFallback: true,
    vad: true,
    vadModelPath: "silero-vad.bin",
    vadOptions: {
      threshold: 0.42,
      minSpeechDurationMs: 120,
      minSilenceDurationMs: 350,
      speechPadMs: 80,
      samplesOverlap: 0.15
    }
  }, "output");

  assert.deepEqual(args, [
    "-m", "model.gguf", "-f", "audio.wav", "-l", "zh", "-t", "6",
    "-ojf", "-of", "output", "-ng",
    "-bs", "8", "-sow", "-nth", "0.45", "-lpt", "-1.2", "-tp", "0",
    "-bo", "8", "-et", "2.2", "-tpi", "0.2",
    "--prompt", "角色名 专有术语; 产品名, 地名", "--carry-initial-prompt", "-sns", "-nfa",
    "--vad", "-vm", "silero-vad.bin", "-vt", "0.42", "-vspd", "120",
    "-vsd", "350", "-vp", "80", "-vo", "0.15"
  ]);
  assert.equal(args.indexOf("256"), -1);

  var noFallbackArgs = whispercpp.buildArgs(runtime, {
    modelPath: "model.gguf",
    audioPath: "audio.wav",
    language: "auto",
    device: "auto",
    temperatureFallback: false,
    temperatureInc: 0.4,
    vad: false
  }, "no-fallback-output");
  assert.ok(noFallbackArgs.indexOf("-nf") >= 0);
  assert.equal(noFallbackArgs.indexOf("-tpi"), -1);

  var fallbackArgs = whispercpp.buildArgs(runtime, {
    modelPath: "model.gguf",
    audioPath: "audio.wav",
    language: "auto",
    device: "auto",
    temperatureFallback: true,
    vad: false
  }, "fallback-output");
  assert.deepEqual(fallbackArgs.slice(fallbackArgs.indexOf("-tpi"), fallbackArgs.indexOf("-tpi") + 2), ["-tpi", "0.20"]);
});

test("whisper.cpp JSON quality preserves token diagnostics and weighted confidence", function () {
  var segments = whispercpp.parseWhisperJson({
    transcription: [
      {
        offsets: { from: 0, to: 1000 },
        text: " hello world",
        avg_logprob: -0.2,
        no_speech_prob: 0.03,
        tokens: [
          { id: 1, text: " hello", offsets: { from: 0, to: 400 }, p: 0.9, t_dtw: 0.1 },
          { id: 2, text: " world", offsets: { from: 450, to: 1000 }, p: 0.7, t_dtw: 0.2 }
        ]
      },
      {
        offsets: { from: 1200, to: 1500 },
        text: " maybe",
        tokens: [{ id: 3, text: " maybe", offsets: { from: 1200, to: 1500 }, p: 0.3 }]
      }
    ]
  });
  var quality = whispercpp.summarizeQuality(segments);

  assert.equal(segments[0].words[0].tokenId, 1);
  assert.equal(segments[0].words[0].tDtw, 0.1);
  assert.equal(segments[0].quality.averageProbability, 0.8);
  assert.equal(segments[0].quality.meanWordProbability, 0.8);
  assert.equal(segments[0].quality.minWordProbability, 0.7);
  assert.equal(segments[0].quality.averageLogProbability, -0.2);
  assert.equal(segments[0].quality.avgLogprob, -0.2);
  assert.equal(segments[0].quality.noSpeechProbability, 0.03);
  assert.equal(segments[0].quality.noSpeechProb, 0.03);
  assert.equal(quality.tokenCount, 3);
  assert.equal(quality.timedTokenCount, 3);
  assert.ok(Math.abs(quality.averageProbability - (1.9 / 3)) < 1e-12);
  assert.equal(quality.lowConfidenceCount, 1);
});

test("whisper.cpp JSON parser tolerates null tokens from a partial runtime response", function () {
  var segments = whispercpp.parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 10 }, text: "", tokens: [null] }] });
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].words, []);
});

test("whisper.cpp run returns detected language and aggregate quality", async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-cpp-quality-"));
  var prefix = path.join(root, "result");
  fs.writeFileSync(prefix + ".json", JSON.stringify({
    result: { language: "zh", language_probability: 0.92 },
    transcription: [{
      offsets: { from: 0, to: 500 },
      text: " 测试",
      tokens: [{ text: " 测试", offsets: { from: 0, to: 500 }, p: 0.8 }]
    }]
  }), "utf8");
  var originalSpawn = processController.spawnProcess;
  processController.spawnProcess = function (_, __, ___, callback) {
    process.nextTick(function () { callback(null); });
    return { cancel: function () {} };
  };
  try {
    var result = await new Promise(function (resolve, reject) {
      whispercpp.run({ executable: "fake-whisper.exe", flags: { jsonFull: "-ojf" }, capabilities: { wordTimestamps: true, vad: false } }, {
        cwd: root,
        outputPrefix: prefix,
        modelPath: "model.gguf",
        audioPath: "audio.wav",
        language: "auto",
        threads: 2,
        device: "auto",
        vad: false
      }, {}, function (error, value) { if (error) reject(error); else resolve(value); });
    });
    assert.equal(result.language, "zh");
    assert.equal(result.languageProbability, 0.92);
    assert.equal(result.quality.averageProbability, 0.8);
    assert.equal(result.engine.quality, result.quality);
  } finally {
    processController.spawnProcess = originalSpawn;
  }
});
