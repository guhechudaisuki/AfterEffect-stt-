const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workspace = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(workspace, "extension/jsx/common/keyframe-time.jsx"), "utf8");

function loadMapper() {
    const context = { $: { _LWS: {} }, Error, Math, Number };
    vm.runInNewContext(source, context, { filename: "keyframe-time.jsx" });
    return context.$._LWS;
}

test("maps a two-second source interval onto a five-second target interval", () => {
    const mapper = loadMapper();
    const mapped = [10, 10.5, 11, 12].map((time) => mapper.mapKeyTime(time, 10, 12, 20, 25));
    assert.deepEqual(mapped, [20, 21.25, 22.5, 25]);
});

test("clamps source times to the effective source interval", () => {
    const mapper = loadMapper();
    assert.equal(mapper.mapKeyTime(9, 10, 12, 20, 25), 20);
    assert.equal(mapper.mapKeyTime(13, 10, 12, 20, 25), 25);
});

test("scales temporal speed by source duration over target duration", () => {
    const mapper = loadMapper();
    assert.equal(mapper.scaleTemporalSpeed(10, 10, 12, 20, 25), 4);
});

test("rejects zero-length effective ranges", () => {
    const mapper = loadMapper();
    assert.throws(
        () => mapper.mapKeyTime(10, 10, 10, 20, 25),
        (error) => error.code === "AE_INVALID_LAYER_DURATION"
    );
    assert.throws(
        () => mapper.scaleTemporalSpeed(10, 10, 12, 20, 20),
        (error) => error.code === "AE_INVALID_LAYER_DURATION"
    );
});
