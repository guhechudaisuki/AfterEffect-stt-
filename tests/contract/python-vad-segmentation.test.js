const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const test = require("node:test");

test("Python bridge decodes VAD regions independently and restores source timestamps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-python-vad-"));
    const audio = path.join(root, "input.wav");
    const request = path.join(root, "request.json");
    const script = [
        "import json, os, sys, wave",
        "sys.path.insert(0, sys.argv[1])",
        "import whisper_bridge",
        "import types",
        "audio = sys.argv[2]",
        "with wave.open(audio, 'wb') as w:",
        "    w.setnchannels(1)",
        "    w.setsampwidth(2)",
        "    w.setframerate(16000)",
        "    w.writeframes(b'\\0\\0' * 16000 * 4)",
        "def decode(path, index, offset, start, end):",
        "    assert os.path.isfile(path)",
        "    return {'language': 'en', 'segments': [{'startMs': 50, 'endMs': 250, 'text': 'region-%d' % index, 'words': [{'text': 'region-%d' % index, 'startMs': 50, 'endMs': 250}]}]}",
        "result = whisper_bridge.transcribe_regions({'audioPath': audio, 'outputPath': os.path.join(os.path.dirname(audio), 'out.json'), 'speechRegions': [{'startMs': 1000, 'endMs': 1300}, {'startMs': 2000, 'endMs': 2300}]}, decode)",
        "fallback = whisper_bridge.segment_timestamp_chunks({'chunks': [{'text': '一句。', 'timestamp': (0.1, 0.4)}, {'text': '第二句。', 'timestamp': (0.5, 0.8)}]}, 'zh')",
        "class FakeWhisperModel:",
        "    calls = 0",
        "    def transcribe(self, path, **kwargs):",
        "        FakeWhisperModel.calls += 1",
        "        return {'language': 'en', 'segments': [{'start': 0.05, 'end': 0.25, 'text': 'ok', 'words': [{'word': 'ok', 'start': 0.05, 'end': 0.25}]}]}",
        "fake_whisper = types.ModuleType('whisper')",
        "fake_whisper.loads = 0",
        "def load_model(path, device=None):",
        "    fake_whisper.loads += 1",
        "    return FakeWhisperModel()",
        "fake_whisper.load_model = load_model",
        "sys.modules['whisper'] = fake_whisper",
        "engine_result = whisper_bridge.run_openai({'modelPath': audio, 'audioPath': audio, 'outputPath': os.path.join(os.path.dirname(audio), 'out.json'), 'device': 'cpu', 'speechRegions': [{'startMs': 1000, 'endMs': 1300}, {'startMs': 2000, 'endMs': 2300}]})",
        "print(json.dumps({'helper': result, 'fallback': fallback, 'engine': engine_result, 'loads': fake_whisper.loads, 'calls': FakeWhisperModel.calls}, ensure_ascii=False))",
    ].join("\n");
    fs.writeFileSync(request, "{}", "utf8");
    const output = cp.execFileSync("python", ["-c", script, path.resolve(__dirname, "../../extension/python"), audio], { encoding: "utf8" });
    const payload = JSON.parse(output.trim().split(/\r?\n/).pop());
    const result = payload.helper;
    assert.equal(payload.loads, 1);
    assert.equal(payload.calls, 2);
    assert.deepEqual(payload.fallback.segments.map((item) => [item.startMs, item.endMs]), [[100, 400], [500, 800]]);
    assert.deepEqual(payload.engine.segments.map((item) => [item.startMs, item.endMs, item.text]), [
        [1000, 1200, "ok"],
        [2000, 2200, "ok"],
    ]);
    assert.deepEqual(result.segments.map((item) => item.words[0].vadRegionId), ["vad-0", "vad-1"]);
});
