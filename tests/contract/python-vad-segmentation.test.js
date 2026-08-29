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
        "    kwargs = []",
        "    def transcribe(self, path, **kwargs):",
        "        FakeWhisperModel.calls += 1",
        "        FakeWhisperModel.kwargs.append(kwargs)",
        "        return {'language': 'en', 'segments': [{'start': 0.05, 'end': 0.25, 'text': 'ok', 'words': [{'word': 'ok', 'start': 0.05, 'end': 0.25}]}]}",
        "fake_whisper = types.ModuleType('whisper')",
        "fake_whisper.loads = 0",
        "def load_model(path, device=None):",
        "    fake_whisper.loads += 1",
        "    return FakeWhisperModel()",
        "fake_whisper.load_model = load_model",
        "sys.modules['whisper'] = fake_whisper",
        "engine_result = whisper_bridge.run_openai({'modelPath': audio, 'audioPath': audio, 'outputPath': os.path.join(os.path.dirname(audio), 'out.json'), 'device': 'cpu', 'speechRegions': [{'startMs': 1000, 'endMs': 1300}, {'startMs': 2000, 'endMs': 2300}]})",
        "print(json.dumps({'helper': result, 'fallback': fallback, 'engine': engine_result, 'loads': fake_whisper.loads, 'calls': FakeWhisperModel.calls, 'kwargs': FakeWhisperModel.kwargs}, ensure_ascii=False))",
    ].join("\n");
    fs.writeFileSync(request, "{}", "utf8");
    const output = cp.execFileSync("python", ["-c", script, path.resolve(__dirname, "../../extension/python"), audio], { encoding: "utf8" });
    const payload = JSON.parse(output.trim().split(/\r?\n/).pop());
    const result = payload.helper;
    assert.equal(payload.loads, 1);
    assert.equal(payload.calls, 2);
    assert.deepEqual(payload.kwargs.map((item) => item.no_speech_threshold), [0.95, 0.95]);
    assert.deepEqual(payload.kwargs.map((item) => item.temperature), [[0, 0.2, 0.4], [0, 0.2, 0.4]]);
    assert.deepEqual(payload.kwargs.map((item) => item.condition_on_previous_text), [false, false]);
    assert.deepEqual(payload.fallback.segments.map((item) => [item.startMs, item.endMs]), [[100, 400], [500, 800]]);
    assert.deepEqual(payload.engine.segments.map((item) => [item.startMs, item.endMs, item.text]), [
        [1000, 1200, "ok"],
        [2000, 2200, "ok"],
    ]);
    assert.deepEqual(result.segments.map((item) => item.words[0].vadRegionId), ["vad-0", "vad-1"]);
});

test("Python bridge applies the new decode-region context, merge policy, and quality metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-python-quality-"));
    const audio = path.join(root, "input.wav");
    const script = [
        "import json, os, sys, wave",
        "sys.path.insert(0, sys.argv[1])",
        "import whisper_bridge",
        "audio = sys.argv[2]",
        "with wave.open(audio, 'wb') as w:",
        "    w.setnchannels(1)",
        "    w.setsampwidth(2)",
        "    w.setframerate(16000)",
        "    w.writeframes(b'\\0\\0' * 16000 * 4)",
        "clip_lengths = []",
        "def decode(path, index, offset, start, end):",
        "    with wave.open(path, 'rb') as w:",
        "        clip_lengths.append(round(w.getnframes() * 1000.0 / w.getframerate()))",
        "    local_start = start - offset",
        "    return {'language': 'en', 'segments': [{'startMs': local_start, 'endMs': local_start + 200, 'text': 'ok', 'words': [{'text': 'ok', 'startMs': local_start, 'endMs': local_start + 200, 'probability': 0.8}], 'quality': {'meanWordProbability': 0.8}}]}",
        "request = {'audioPath': audio, 'outputPath': os.path.join(os.path.dirname(audio), 'out.json'), 'decodeRegions': [{'startMs': 1000, 'endMs': 1300}, {'startMs': 1700, 'endMs': 2000}], 'decodeRegionMergeGapMs': 0}",
        "decoded = whisper_bridge.transcribe_regions(request, decode)",
        "quality = whisper_bridge.normalize_segments([{'start': 0.1, 'end': 0.5, 'text': 'hello', 'avg_logprob': -0.2, 'no_speech_prob': 0.1, 'words': [{'word': 'hello', 'start': 0.1, 'end': 0.5, 'probability': 0.75}]}])[0]['quality']",
        "filtered = whisper_bridge.shift_region_segments([{'startMs': 0, 'endMs': 500, 'text': 'outside inside', 'words': [{'text': 'outside', 'startMs': 0, 'endMs': 100}, {'text': 'inside', 'startMs': 250, 'endMs': 350}]}], 760, 1000, 1300, 0)",
        "fallback = whisper_bridge.segment_timestamp_chunks({'text': 'kept'}, 'en', 400)",
        "def legacy_backend(**kwargs):",
        "    if 'new_option' in kwargs: raise TypeError(\"got an unexpected keyword argument 'new_option'\")",
        "    return kwargs",
        "compatible = whisper_bridge.call_with_compat(legacy_backend, keep=2, new_option=1, _optional_keys=('new_option',))",
        "print(json.dumps({'clip_lengths': clip_lengths, 'times': [[x['startMs'], x['endMs']] for x in decoded['segments']], 'quality': quality, 'filtered_words': [word['text'] for word in filtered[0]['words']], 'fallback_end': fallback['segments'][0]['endMs'], 'disabled': whisper_bridge.temperature_schedule({'temperatureFallback': False}), 'custom': whisper_bridge.temperature_schedule({'temperatureFallbacks': [0, 0.3, 0.3, 2]}), 'beam': whisper_bridge.decoder_beam_size({'beamSize': 99}), 'prompt': whisper_bridge.decode_prompt({'initialPrompt': '  name\\n  phrase  '}), 'compatible': compatible}))",
    ].join("\n");
    const output = cp.execFileSync("python", ["-c", script, path.resolve(__dirname, "../../extension/python"), audio], { encoding: "utf8" });
    const payload = JSON.parse(output.trim().split(/\r?\n/).pop());
    assert.deepEqual(payload.clip_lengths, [780, 780]);
    assert.deepEqual(payload.times, [[1000, 1200], [1700, 1900]]);
    assert.equal(payload.quality.meanWordProbability, 0.75);
    assert.equal(payload.quality.minWordProbability, 0.75);
    assert.equal(payload.quality.avgLogprob, -0.2);
    assert.equal(payload.quality.noSpeechProb, 0.1);
    assert.deepEqual(payload.filtered_words, ["inside"]);
    assert.equal(payload.fallback_end, 400);
    assert.deepEqual(payload.disabled, [0]);
    assert.deepEqual(payload.custom, [0, 0.3]);
    assert.equal(payload.beam, 16);
    assert.equal(payload.prompt, "name phrase");
    assert.deepEqual(payload.compatible, { keep: 2 });
});

test("Transformers Whisper requests word timestamps for bounded and unbounded audio", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-python-transformers-"));
    const audio = path.join(root, "input.wav");
    const script = [
        "import json, os, sys, types, wave",
        "sys.path.insert(0, sys.argv[1])",
        "import whisper_bridge",
        "audio = sys.argv[2]",
        "with wave.open(audio, 'wb') as w:",
        "    w.setnchannels(1)",
        "    w.setsampwidth(2)",
        "    w.setframerate(16000)",
        "    w.writeframes(b'\\0\\0' * 16000)",
        "class FakeCuda:",
        "    @staticmethod",
        "    def is_available(): return False",
        "    @staticmethod",
        "    def empty_cache(): return None",
        "fake_torch = types.ModuleType('torch')",
        "fake_torch.float16 = 'float16'",
        "fake_torch.float32 = 'float32'",
        "fake_torch.cuda = FakeCuda()",
        "sys.modules['torch'] = fake_torch",
        "modes = []",
        "class FakeProcessor:",
        "    tokenizer = object()",
        "    feature_extractor = object()",
        "    @classmethod",
        "    def from_pretrained(cls, *args, **kwargs): return cls()",
        "class FakeModel:",
        "    @classmethod",
        "    def from_pretrained(cls, *args, **kwargs): return cls()",
        "def pipeline(*args, **kwargs):",
        "    def recognize(audio_value, return_timestamps=None, generate_kwargs=None):",
        "        modes.append(return_timestamps)",
        "        return {'text': 'hello', 'chunks': [{'text': 'hello', 'timestamp': (0.1, 0.4), 'score': 0.8}]} ",
        "    return recognize",
        "fake_transformers = types.ModuleType('transformers')",
        "fake_transformers.AutoModelForSpeechSeq2Seq = FakeModel",
        "fake_transformers.AutoProcessor = FakeProcessor",
        "fake_transformers.pipeline = pipeline",
        "sys.modules['transformers'] = fake_transformers",
        "whisper_bridge.read_pcm_wav = lambda path: {'raw': [0.0], 'sampling_rate': 16000}",
        "common = {'modelPath': os.path.dirname(audio), 'audioPath': audio, 'outputPath': os.path.join(os.path.dirname(audio), 'out.json'), 'device': 'cpu', 'language': 'en'}",
        "bounded = dict(common)",
        "bounded['decodeRegions'] = [{'startMs': 200, 'endMs': 800}]",
        "first = whisper_bridge.run_transformers(bounded)",
        "second = whisper_bridge.run_transformers(common)",
        "print(json.dumps({'modes': modes, 'bounded_quality': first['segments'][0].get('quality'), 'unbounded_count': len(second['segments'])}))",
    ].join("\n");
    const output = cp.execFileSync("python", ["-c", script, path.resolve(__dirname, "../../extension/python"), audio], { encoding: "utf8" });
    const payload = JSON.parse(output.trim().split(/\r?\n/).pop());
    assert.deepEqual(payload.modes, ["word", "word"]);
    assert.equal(payload.bounded_quality.meanWordProbability, 0.8);
    assert.equal(payload.unbounded_count, 1);
});

test("Python Whisper retries a weak bounded decode and keeps the higher-quality result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-python-quality-retry-"));
    const audio = path.join(root, "input.wav");
    const script = [
        "import json, os, sys, types, wave",
        "sys.path.insert(0, sys.argv[1])",
        "import whisper_bridge",
        "audio = sys.argv[2]",
        "with wave.open(audio, 'wb') as w:",
        "    w.setnchannels(1)",
        "    w.setsampwidth(2)",
        "    w.setframerate(16000)",
        "    w.writeframes(b'\\0\\0' * 16000 * 2)",
        "class FakeWhisperModel:",
        "    calls = 0",
        "    def transcribe(self, path, **kwargs):",
        "        FakeWhisperModel.calls += 1",
        "        if FakeWhisperModel.calls == 1:",
        "            return {'language': 'en', 'segments': [{'start': 0.2, 'end': 0.5, 'text': 'weak', 'avg_logprob': -2.0, 'no_speech_prob': 0.8, 'words': [{'word': 'weak', 'start': 0.2, 'end': 0.5, 'probability': 0.25}]}]}",
        "        return {'language': 'en', 'segments': [{'start': 0.2, 'end': 0.5, 'text': 'strong', 'avg_logprob': -0.2, 'no_speech_prob': 0.05, 'words': [{'word': 'strong', 'start': 0.2, 'end': 0.5, 'probability': 0.95}]}]}",
        "fake_whisper = types.ModuleType('whisper')",
        "fake_whisper.load_model = lambda path, device=None: FakeWhisperModel()",
        "sys.modules['whisper'] = fake_whisper",
        "result = whisper_bridge.run_openai({'modelPath': audio, 'audioPath': audio, 'outputPath': os.path.join(os.path.dirname(audio), 'out.json'), 'device': 'cpu', 'decodeRegions': [{'startMs': 500, 'endMs': 1000}]})",
        "print(json.dumps({'calls': FakeWhisperModel.calls, 'text': result['segments'][0]['text'], 'confidence': result['segments'][0]['quality']['meanWordProbability']}))",
    ].join("\n");
    const output = cp.execFileSync("python", ["-c", script, path.resolve(__dirname, "../../extension/python"), audio], { encoding: "utf8" });
    const payload = JSON.parse(output.trim().split(/\r?\n/).pop());
    assert.equal(payload.calls, 2);
    assert.equal(payload.text, "strong");
    assert.equal(payload.confidence, 0.95);
});
