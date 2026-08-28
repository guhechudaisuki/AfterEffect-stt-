const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspace = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(workspace, "extension/js/app.js"), "utf8");
const aeHost = fs.readFileSync(path.join(workspace, "extension/jsx/AEFT/host.jsx"), "utf8");
const preprocessor = fs.readFileSync(path.join(workspace, "extension/js/core/audio-preprocessor.js"), "utf8");
const runner = fs.readFileSync(path.join(workspace, "extension/js/core/transcription-runner.js"), "utf8");
const pythonBridge = fs.readFileSync(path.join(workspace, "extension/python/whisper_bridge.py"), "utf8");
const runtimeProbe = fs.readFileSync(path.join(workspace, "extension/python/runtime_probe.py"), "utf8");

test("AE transcription requests direct source media and preserves the source trim range", () => {
    assert.doesNotMatch(app, /outputModuleTemplate/);
    assert.match(app, /ae\.audio\.export/);
    assert.match(app, /sourceStartMs/);
    assert.match(app, /sourceEndMs/);
    assert.match(app, /alreadyTrimmed: false/);
});

test("audio preprocessor supports trimming a source media file before PCM conversion", () => {
    assert.match(preprocessor, /startMs/);
    assert.match(preprocessor, /endMs/);
    assert.match(preprocessor, /-ss/);
    assert.match(preprocessor, /-t/);
});

test("AE source audio is conformed to layer stretch before STT timing is mapped", () => {
    const start = aeHost.indexOf('$._LWS.register("ae.audio.export"');
    const end = aeHost.indexOf('$._LWS.register("ae.subtitles.create"', start);
    const audioRoute = aeHost.slice(start, end);
    assert.match(audioRoute, /playbackRate/);
    assert.match(audioRoute, /reverse/);
    assert.match(audioRoute, /Math\.min\(sourceAtStart, sourceAtEnd\)/);
    assert.match(audioRoute, /AE_TIME_REMAP_UNSUPPORTED/);
    assert.match(preprocessor, /atempo=/);
    assert.match(preprocessor, /reversePcm16File/);
    assert.match(runner, /playbackRate/);
});

test("AE reverse layers map processed Whisper times back before subtitle creation", () => {
    const segmentUtils = require("../../extension/js/core/segment-utils");
    const mapped = segmentUtils.mapCuesForReverse([
        { startMs: 1000, endMs: 2000, relativeStartMs: 1000, relativeEndMs: 2000, timingSource: "wordTimestamp" }
    ], 5000, 0);
    assert.deepEqual([mapped[0].startMs, mapped[0].endMs], [3000, 4000]);
});

test("optional UVR5 vocal separation runs after timeline conformance and before STT", () => {
    assert.match(runner, /uvr5Preprocessor/);
    assert.match(runner, /separatingVocals/);
    assert.match(runner, /uvr5-vocal\.wav/);
    assert.match(app, /uvr5Model/);
    assert.match(app, /vadPythonExecutable/);
    assert.match(runner, /speechVad/);
    assert.match(runner, /detectingSpeech/);
});

test("VAD speech isolation is applied before Whisper and Python decoding uses stable settings", () => {
    const runner = fs.readFileSync(path.join(workspace, "extension/js/core/transcription-runner.js"), "utf8");
    const bridge = fs.readFileSync(path.join(workspace, "extension/python/whisper_bridge.py"), "utf8");
    const isolator = fs.readFileSync(path.join(workspace, "extension/js/core/speech-isolator.js"), "utf8");
    const runtimeDetector = fs.readFileSync(path.join(workspace, "extension/js/core/runtime-detector.js"), "utf8");
    const whisperCpp = fs.readFileSync(path.join(workspace, "extension/js/core/whispercpp-adapter.js"), "utf8");
    assert.match(runner, /speechIsolator\.isolatePcm16MonoWav/);
    assert.match(runner, /speech-isolated\.wav/);
    assert.match(runner, /speechIsolation/);
    assert.match(bridge, /beam_size=5/);
    assert.match(bridge, /condition_on_previous_text=False/);
    assert.match(bridge, /min_silence_duration_ms/);
    assert.match(runtimeDetector, /beamSize/);
    assert.match(whisperCpp, /flags\.beamSize/);
    assert.match(isolator, /normalizeRegions/);
    assert.match(isolator, /paddingMs/);
});

test("selected AE audio/video layers are transcribed one source at a time", () => {
    const start = aeHost.indexOf('$._LWS.register("ae.audio.export"');
    const end = aeHost.indexOf('$._LWS.register("ae.subtitles.create"', start);
    const audioRoute = aeHost.slice(start, end);
    assert.match(audioRoute, /params\.layerIds/);
    assert.match(audioRoute, /sources:/);
    assert.match(app, /layerIds/);
    assert.match(app, /sources\.length/);
    assert.match(app, /runner\.run\(/);
    assert.match(app, /writeHostResult\(result, source\)\.then/);
    assert.match(app, /runSource\(index \+ 1\)/);
    assert.doesNotMatch(app, /writeHostResult\(aggregate/);
    assert.doesNotMatch(app, /aggregate\.segments/);
});

test("silent selected layers are skipped before Whisper starts", () => {
    assert.match(preprocessor, /hasAudioSignal/);
    assert.match(runner, /hasAudioSignal/);
    assert.match(runner, /AUDIO_NO_SIGNAL/);
});

test("Python Whisper engines leave loading state before blocking transcription", () => {
    [
        ["def run_openai", "result = model.transcribe("],
        ["def run_faster", "segments, info = model.transcribe("],
        ["def run_transformers", "result = recognizer("]
    ].forEach(([functionName, recognizerCallText]) => {
        const functionStart = pythonBridge.indexOf(functionName);
        const loadingComplete = pythonBridge.indexOf('"phase": "loadingModel", "percent": 100', functionStart);
        const transcribing = pythonBridge.indexOf('event({"phase": "transcribing", "percent": None', loadingComplete);
        const recognizerCall = pythonBridge.indexOf(recognizerCallText, loadingComplete);
        assert.ok(functionStart >= 0 && loadingComplete > functionStart && transcribing > loadingComplete && recognizerCall > transcribing, functionName);
    });
    assert.match(app, /runStartedAt/);
    assert.match(app, /formatElapsed/);
});

test("Transformers hybrid mode loads one model with an automatic CPU/GPU device map", () => {
    assert.match(runtimeProbe, /accelerate/);
    assert.match(pythonBridge, /allowHybrid/);
    assert.match(pythonBridge, /device_map="auto"/);
    assert.match(pythonBridge, /max_memory=max_memory/);
    assert.match(pythonBridge, /model_size_bytes \* 0\.75/);
    assert.match(pythonBridge, /if not hasattr\(torch, "float8_e4m3fn"\)/);
    assert.match(pythonBridge, /torch\.float8_e4m3fn = torch\.float16/);
    assert.match(pythonBridge, /previous_word_start_ms/);
    assert.match(pythonBridge, /previous_word_end_ms/);
    assert.match(pythonBridge, /start_ms = max\(start_ms, previous_word_end_ms\)/);
    assert.match(pythonBridge, /max_word_end_ms/);
    assert.match(pythonBridge, /placement = "hybrid"/);
    assert.doesNotMatch(pythonBridge, /run_transformers[\s\S]*model\.transcribe/);
});

test("Transformers VAD clips avoid the short-clip token timestamp crash", () => {
    assert.match(pythonBridge, /timestamp_mode = True if request\.get\("speechRegions"\) else "word"/);
    assert.match(pythonBridge, /except IndexError as error/);
    assert.match(pythonBridge, /segment_timestamp_chunks/);
    assert.match(pythonBridge, /return_timestamps=True/);
});
