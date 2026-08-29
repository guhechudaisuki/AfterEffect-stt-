"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var segmentUtils = require("../extension/js/core/segment-utils");
var srt = require("../extension/js/core/srt");
var scanner = require("../extension/js/core/model-scanner");
var matcher = require("../extension/js/core/model-runtime-matcher");
var whispercpp = require("../extension/js/core/whispercpp-adapter");
var jobSchema = require("../extension/js/core/job-schema");
var translation = require("../extension/js/core/translation-client");
var audioPreprocessor = require("../extension/js/core/audio-preprocessor");
var speechIsolator = require("../extension/js/core/speech-isolator");

function rawSegment(words, text) {
  return [{ id: "raw-0", startMs: words[0].startMs, endMs: words[words.length - 1].endMs, text: text, words: words }];
}

test("smart segmentation splits multiple Chinese sentences inside one Whisper segment", function () {
  var words = [
    { text: "你好。", startMs: 0, endMs: 300 },
    { text: "今天", startMs: 360, endMs: 620 },
    { text: "很好！", startMs: 650, endMs: 980 },
    { text: "再见。", startMs: 1040, endMs: 1380 }
  ];
  var cues = segmentUtils.formatSegments(rawSegment(words, "你好。今天很好！再见。"), 10000, { maxCharsPerLine: 0 });
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map(function (cue) { return [cue.startMs, cue.endMs]; }), [[10000, 10300], [10360, 10980], [11040, 11380]]);
  assert.equal(cues[0].sourceLines.length, 1);
});

test("maxCharsPerLine zero does not disable sentence segmentation", function () {
  var words = [
    { text: "One.", startMs: 0, endMs: 200 },
    { text: "Two!", startMs: 220, endMs: 480 }
  ];
  var cues = segmentUtils.formatSegments(rawSegment(words, "One. Two!"), 0, { maxCharsPerLine: 0 });
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map(function (cue) { return cue.sourceText; }), ["One.", "Two!"]);
});

test("sentence continues across adjacent Whisper raw segments before smart splitting", function () {
  var cues = segmentUtils.formatSegments([
    { id: "raw-a", startMs: 0, endMs: 450, text: "这是一段", words: [
      { text: "这是一段", startMs: 0, endMs: 450 }
    ] },
    { id: "raw-b", startMs: 470, endMs: 1000, text: "连续的话。", words: [
      { text: "连续的话。", startMs: 470, endMs: 1000 }
    ] }
  ], 0, { maxCharsPerLine: 0 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].sourceText, "这是一段连续的话。");
  assert.deepEqual(cues[0].sourceSegmentIds, ["raw-a", "raw-b"]);
  assert.deepEqual([cues[0].startMs, cues[0].endMs], [0, 1000]);
});

test("speech boundaries trim leading and trailing silence from Whisper cues", function () {
  var words = [
    { text: "hello", startMs: 0, endMs: 1400 },
    { text: "world", startMs: 1600, endMs: 3000 }
  ];
  var cues = segmentUtils.formatSegments([
    { id: "raw-0", startMs: 0, endMs: 4000, text: "hello world", words: words }
  ], 10000, {
    maxCharsPerLine: 0,
    speechRegions: [{ startMs: 1000, endMs: 2600 }]
  });
  assert.deepEqual(cues.map(function (cue) { return [cue.startMs, cue.endMs]; }), [[11000, 12600]]);
  assert.equal(cues[0].timingSource, "wordTimestamp+speechBoundary");
});

test("speech regions remain hard sentence boundaries when Whisper joins two utterances", function () {
  var cues = segmentUtils.formatSegments([
    { id: "raw-0", startMs: 0, endMs: 3000, text: "one two", words: [
      { text: "one", startMs: 200, endMs: 700 },
      { text: "two", startMs: 1500, endMs: 2100 }
    ] }
  ], 0, {
    maxCharsPerLine: 0,
    pauseHardMs: 5000,
    speechRegions: [{ startMs: 100, endMs: 800 }, { startMs: 1400, endMs: 2200 }]
  });
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map(function (cue) { return [cue.startMs, cue.endMs]; }), [[200, 700], [1500, 2100]]);
});

test("reverse layer cues map back to the original timeline", function () {
  var cues = [
    { startMs: 1000, endMs: 2000, relativeStartMs: 1000, relativeEndMs: 2000, timingSource: "wordTimestamp" },
    { startMs: 3000, endMs: 4500, relativeStartMs: 3000, relativeEndMs: 4500, timingSource: "wordTimestamp" }
  ];
  var mapped = segmentUtils.mapCuesForReverse(cues, 5000, 0);
  assert.deepEqual(mapped.map(function (cue) { return [cue.startMs, cue.endMs]; }), [[500, 2000], [3000, 4000]]);
  assert.ok(mapped.every(function (cue) { return /reverseMapped/.test(cue.timingSource); }));
});

test("speech-region detector ignores quiet leading and trailing WAV samples", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-speech-"));
  var file = path.join(root, "input.wav");
  var sampleRate = 16000;
  var frames = sampleRate * 2;
  var data = Buffer.alloc(frames * 2);
  for (var i = sampleRate * 0.5; i < sampleRate * 1.5; i += 1) data.writeInt16LE(9000, i * 2);
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
  fs.writeFileSync(file, Buffer.concat([header, data]));
  var regions = audioPreprocessor.detectSpeechRegions(file, { windowMs: 20, minSpeechMs: 40 });
  assert.equal(regions.length, 1);
  assert.ok(regions[0].startMs >= 480 && regions[0].startMs <= 520);
  assert.ok(regions[0].endMs >= 1480 && regions[0].endMs <= 1520);
});

test("audio preprocessor supports a high-bandwidth UVR5 target before 16 kHz STT", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-uvr-format-"));
  var file = path.join(root, "uvr-input.wav");
  var sampleRate = 44100;
  var data = Buffer.alloc(sampleRate * 2);
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
  fs.writeFileSync(file, Buffer.concat([header, data]));
  assert.equal(audioPreprocessor.needsConversionFor(file, { targetSampleRate: 44100, targetChannels: 1 }), false);
  assert.equal(audioPreprocessor.needsConversion(file), true);
});

test("PCM reversal preserves channel order for stereo UVR5 input", function () {
  var samples = Buffer.alloc(4 * 2 * 2);
  // Frames: (L=1,R=10), (2,20), (3,30), (4,40).
  [[1, 10], [2, 20], [3, 30], [4, 40]].forEach(function (frame, index) {
    samples.writeInt16LE(frame[0], index * 4);
    samples.writeInt16LE(frame[1], index * 4 + 2);
  });
  audioPreprocessor.reversePcm16Buffer(samples, 2);
  assert.deepEqual([0, 1, 2, 3].map(function (index) { return [samples.readInt16LE(index * 4), samples.readInt16LE(index * 4 + 2)]; }), [[4, 40], [3, 30], [2, 20], [1, 10]]);
});

test("speech-region detector adapts to changing noise and retains sustained quiet speech", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-speech-dynamic-"));
  var file = path.join(root, "input.wav");
  var sampleRate = 16000;
  var frames = sampleRate * 10;
  var data = Buffer.alloc(frames * 2);
  for (var i = 0; i < frames; i += 1) {
    var timeMs = i * 1000 / sampleRate;
    var amplitude = timeMs < 4000 ? 500 : 1800;
    if (timeMs >= 2000 && timeMs < 3000) amplitude = 1500;
    if (timeMs >= 6000 && timeMs < 7000) amplitude = 3600;
    data.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
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
  fs.writeFileSync(file, Buffer.concat([header, data]));

  var regions = audioPreprocessor.detectSpeechRegions(file, {
    windowMs: 20,
    bridgeMs: 100,
    minSpeechMs: 60,
    marginDb: 8,
    minDb: -50
  });

  assert.equal(regions.length, 2);
  assert.deepEqual(regions.map(function (region) { return [region.startMs, region.endMs]; }), [
    [2000, 3000],
    [6000, 7000]
  ]);
});

test("speech isolator preserves the WAV timeline and zeros non-speech audio", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-isolator-"));
  var input = path.join(root, "input.wav");
  var output = path.join(root, "isolated.wav");
  var sampleRate = 16000;
  var frames = sampleRate * 2;
  var data = Buffer.alloc(frames * 2);
  for (var index = 0; index < frames; index += 1) data.writeInt16LE(index < sampleRate || index >= sampleRate * 1.5 ? 12000 : 0, index * 2);
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
  assert.equal(speechIsolator.isolatePcm16MonoWav(input, output, [{ startMs: 1000, endMs: 1500 }], { paddingMs: 0 }), true);
  var isolated = fs.readFileSync(output);
  assert.equal(isolated.length, fs.statSync(input).size);
  assert.equal(isolated.readInt16LE(100), 0);
  assert.equal(isolated.readInt16LE(44 + sampleRate * 2), 12000);
  assert.equal(isolated.readInt16LE(44 + sampleRate * 1.75 * 2), 0);
});

test("hard pause splits speech without punctuation", function () {
  var words = [
    { text: "第一段", startMs: 0, endMs: 250 },
    { text: "第二段", startMs: 1700, endMs: 2100 }
  ];
  var cues = segmentUtils.buildCues(rawSegment(words, "第一段 第二段"), { pauseHardMs: 900, maxCharsPerLine: 0 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].boundaryReason, "hardPause");
});

test("line capacity wraps then splits without adding minimum duration", function () {
  var words = [{ text: "abcdefghijkl", startMs: 0, endMs: 1200 }];
  var cues = segmentUtils.formatSegments(rawSegment(words, "abcdefghijkl"), 0, { maxCharsPerLine: 3, maxLines: 2 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[1].endMs, 1200);
  assert.equal(cues[0].sourceLines.length, 2);
});

test("SRT formatter includes BOM, CRLF and millisecond timestamps", function () {
  var text = srt.toSrt([{ startMs: 3723004, endMs: 3724506, sourceText: "测试" }]);
  assert.ok(text.startsWith("\uFEFF1\r\n01:02:03,004 --> 01:02:04,506\r\n"));
});

test("scanner recognizes pt, named GGML and CTranslate2 directory", function (_, done) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-scan-"));
  fs.writeFileSync(path.join(root, "large-v3-turbo.pt"), Buffer.from([80, 75, 3, 4]));
  var ggmlFixture = Buffer.alloc(64, 0);
  ggmlFixture.write("lmgg", 0, "ascii");
  fs.writeFileSync(path.join(root, "ggml-small.bin"), ggmlFixture);
  var ct2 = path.join(root, "faster-whisper-small");
  fs.mkdirSync(ct2);
  fs.writeFileSync(path.join(ct2, "model.bin"), Buffer.alloc(16, 1));
  fs.writeFileSync(path.join(ct2, "config.json"), "{}");
  fs.writeFileSync(path.join(ct2, "tokenizer.json"), "{}");
  scanner.scanModels({ mode: "deep", roots: [root], maxDepth: 4 }, function (error, result) {
    try {
      assert.ifError(error);
      var formats = result.models.map(function (model) { return model.format; }).sort();
      assert.ok(formats.indexOf("openai-pt") >= 0);
      assert.ok(formats.indexOf("ggml-bin") >= 0);
      assert.ok(formats.indexOf("ctranslate2") >= 0);
      done();
    } catch (assertionError) { done(assertionError); }
  });
});

test("skip scan performs no discovery", function (_, done) {
  scanner.scanModels({ mode: "skip", roots: ["Z:\\does-not-exist"] }, function (error, result) {
    try { assert.ifError(error); assert.equal(result.models.length, 0); assert.equal(result.mode, "skip"); done(); } catch (assertionError) { done(assertionError); }
  });
});

test("runtime matcher never pairs pt with whisper.cpp", function () {
  var models = [{ id: "pt", format: "openai-pt" }, { id: "ggml", format: "ggml-bin" }];
  var runtimes = [{ id: "cpp", status: "ready", engine: "whisper.cpp", supportedModelFormats: ["ggml-bin", "gguf"], devices: ["cpu"] }];
  var result = matcher.annotateModels(models, runtimes, {});
  assert.equal(result[0].status, "runtimeMissing");
  assert.equal(result[1].status, "ready");
});

test("whisper.cpp JSON parser normalizes offsets and tokens", function () {
  var result = whispercpp.parseWhisperJson({ transcription: [{ offsets: { from: 100, to: 900 }, text: " hello", tokens: [{ text: "hello", offsets: { from: 100, to: 900 }, p: 0.9 }] }] });
  assert.equal(result[0].startMs, 100);
  assert.equal(result[0].words[0].probability, 0.9);
});

test("translation response requires exact IDs and languages", function () {
  var cues = [{ id: "a" }, { id: "b" }];
  assert.throws(function () { translation.validateTranslation(cues, ["zh-CN"], { items: [{ id: "a", translations: { "zh-CN": "甲" } }] }); });
  assert.doesNotThrow(function () { translation.validateTranslation(cues, ["zh-CN"], { items: [{ id: "a", translations: { "zh-CN": "甲" } }, { id: "b", translations: { "zh-CN": "乙" } }] }); });
});

test("job schema rejects invalid range and accepts smart segmentation config", function () {
  assert.throws(function () { jobSchema.validateJob({ jobId: "x", audioInput: { path: "x", timelineInMs: 10, timelineOutMs: 0 }, model: { path: "m", format: "ggml-bin" } }); });
  assert.doesNotThrow(function () { jobSchema.validateJob({ jobId: "x", audioInput: { path: "x", timelineInMs: 0, timelineOutMs: 1000 }, model: { path: "m", format: "ggml-bin" }, transcription: {}, segmentation: { maxCharsPerLine: 0, maxLines: null }, translation: { targetLanguages: [] } }); });
  assert.doesNotThrow(function () { jobSchema.validateJob({ jobId: "source-only", audioInput: { path: "x", timelineInMs: 0, timelineOutMs: 1000 }, model: { path: "m", format: "ggml-bin" }, transcription: {}, segmentation: { maxCharsPerLine: 0, maxLines: null }, translation: { mode: "source", targetLanguages: [], apiKeyRef: null } }); });
  assert.throws(function () { jobSchema.validateJob({ jobId: "unsafe-prompt", audioInput: { path: "x", timelineInMs: 0, timelineOutMs: 1000 }, model: { path: "m", format: "ggml-bin" }, transcription: { initialPrompt: new Array(4098).join("x") }, segmentation: { maxCharsPerLine: 0, maxLines: null }, translation: { mode: "source", targetLanguages: [] } }); });
});
