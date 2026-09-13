const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("STT retry keeps in-region primary text when retry contains only padding", () => {
    const script = String.raw`
import json, sys, types
sys.path.insert(0, sys.argv[1])
import whisper_bridge as b
torch = types.ModuleType('torch'); torch.float16 = 'float16'; torch.float32 = 'float32'; sys.modules['torch'] = torch
class Loader:
    tokenizer = object(); feature_extractor = object()
    @classmethod
    def from_pretrained(cls, *args, **kwargs): return cls()
def pipeline(*args, **kwargs):
    calls = []
    def recognize(audio, **kwargs):
        audio.pop('raw'); audio.pop('sampling_rate'); calls.append(1)
        if len(calls) == 1: return {'text':'inside', 'chunks':[{'text':'inside','timestamp':(.3,None)}]}
        return {'text':'padding', 'chunks':[{'text':'padding','timestamp':(.05,.1)}]}
    return recognize
t = types.ModuleType('transformers'); t.AutoProcessor=Loader; t.AutoModelForSpeechSeq2Seq=Loader; t.pipeline=pipeline; sys.modules['transformers']=t
b.read_pcm_wav=lambda path:{'raw':[0.0], 'sampling_rate':16000}; b.wav_duration_ms=lambda path:680; b.event=lambda payload:None
def regions(request, decode):
    decoded=decode('memory.wav',0,760,1000,1200)
    return {'segments':b.shift_region_segments(decoded['segments'],760,1000,1200,0)}
b.transcribe_regions=regions
request={'device':'cpu','language':'en','modelPath':'unused','decodeRegions':[{'startMs':1000,'endMs':1200}]}
result=b.run_transformers(request)
assert [(s['text'],s['startMs'],s['endMs']) for s in result['segments']]==[('inside',1060,1200)], result
print(json.dumps({'passed':True}))
`;
    const result = cp.spawnSync("python", ["-B", "-c", script, path.resolve(__dirname, "../../extension/python")], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stdout.trim()).passed, true);
});

test("estimated Transformers chunks retain sentence splitting and timing warning", () => {
    const script = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import whisper_bridge as b
result=b.segment_timestamp_chunks({'text':'First sentence. Second sentence.','chunks':[{'text':'First sentence.','timestamp':(None,None)},{'text':' Second sentence.','timestamp':(None,None)}]},'en',2000)
print(json.dumps(result))
`;
    const result = cp.spawnSync("python", ["-B", "-c", script, path.resolve(__dirname, "../../extension/python")], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const raw = JSON.parse(result.stdout.trim());
    const segmentUtils = require(path.resolve(__dirname, "../../extension/js/core/segment-utils.js"));
    const cues = segmentUtils.formatSegments(raw.segments, 0, { maxCharsPerLine: 0 });
    assert.equal(cues.length, 2);
    assert.ok(cues.every((cue) => cue.timingSource === "estimated" && cue.warnings[0].code === "W_TIMING_ESTIMATED"));
});
