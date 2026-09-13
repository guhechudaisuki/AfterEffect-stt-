const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

for (const scenario of [
    "success", "unsupported-option", "timestamp-fallback", "quality-retry", "combined",
    "unrelated-error", "unrelated-keyword", "invalid-condition", "untimed-region",
    "untimed-fallback", "partial-tail", "partial-fallback",
    "untimed-quality-retry", "untimed-timing-retry",
]) {
    test("Transformers consumed audio dictionary: " + scenario, () => {
        const result = cp.spawnSync("python", [
            "-B", path.resolve(__dirname, "../fixtures/transformers-audio-retries.py"),
            path.resolve(__dirname, "../../extension/python"), scenario,
        ], { encoding: "utf8", timeout: 15000 });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const output = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
        assert.equal(output.passed, true);
        assert.equal(output.scenario, scenario);
    });
}

test("Transformers incomplete timestamp boundaries preserve text and known anchors", () => {
    const result = cp.spawnSync("python", [
        "-B", path.resolve(__dirname, "../fixtures/transformers-timestamp-repair.py"),
        path.resolve(__dirname, "../../extension/python"),
    ], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stdout.trim()).passed, true);
});
