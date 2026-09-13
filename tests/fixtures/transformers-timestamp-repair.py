"""Exercise missing timestamp boundaries without model/runtime dependencies."""
import json
import sys

sys.path.insert(0, sys.argv[1])
import whisper_bridge


def chunk(text, start=None, end=None):
    return {"text": text, "timestamp": (start, end)}


cases = [
    ([chunk("head", None, 0.2), chunk(" tail", 0.4, 0.8)],
     [("head", 0, 200), (" tail", 400, 800)]),
    ([chunk("first", 0.1, 0.2), chunk(" mid"), chunk(" dle"), chunk(" last", 0.7, 0.9)],
     [("first", 100, 200), (" mid dle", 200, 700), (" last", 700, 900)]),
    ([chunk("first", 0.1, 0.2), chunk(" tail", 0.5, None)],
     [("first", 100, 200), (" tail", 500, 1000)]),
    ([chunk("all"), chunk(" missing")], [("all missing", 0, 1000)]),
    ([chunk("first", 0.1, 0.4), chunk(" mid"), chunk(" last", 0.4, 0.8)],
     [("first mid", 100, 400), (" last", 400, 800)]),
    ([chunk("head"), chunk(" tail", 0, 0.8)], [("head tail", 0, 800)]),
    ([chunk("only", 0.1, 1.0), chunk(" tail", 1.0, None)], [("only tail", 100, 1000)]),
    ([chunk("bad", float("nan"), float("inf")), chunk(" anchor", 0.4, 0.8)],
     [("bad", 0, 400), (" anchor", 400, 800)]),
    ([], []),
]
for chunks, expected in cases:
    result = {"chunks": chunks}
    before = json.dumps(result)
    words = whisper_bridge.transformers_timed_words(result, 1000)
    actual = [(w["word"], round(w["start"] * 1000), round(w["end"] * 1000)) for w in words]
    assert actual == expected, (actual, expected)
    assert json.dumps(result) == before, "Backend chunks must not be mutated"
    converted = whisper_bridge.segment_timestamp_chunks(result, "en", 1000)
    assert [(s["text"], s["startMs"], s["endMs"]) for s in converted["segments"]] == expected
    assert all(w["end"] > w["start"] for w in words)

assert whisper_bridge.segment_timestamp_chunks({"text": ""}, "en", 1000)["segments"] == []
boundary = whisper_bridge.segment_timestamp_chunks({"chunks": [
    chunk("before", 0.1, 0.24), chunk(" missing", 0.24, None), chunk(" after", 0.24, 0.4),
]}, "en", 680)
shifted = whisper_bridge.shift_region_segments(boundary["segments"], 760, 1000, 1200, 0)
assert "".join(w["text"] for s in shifted for w in s["words"]) == " missing after", shifted
print(json.dumps({"passed": True, "cases": len(cases)}))
