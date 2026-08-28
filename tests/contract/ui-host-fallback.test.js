const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspace = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(workspace, "extension/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(workspace, "extension/index.html"), "utf8");

test("host UI can reveal AE tools before CEP bootstrap completes", () => {
    assert.match(app, /function detectHostFromEnvironment\(\)/);
    assert.match(app, /var environmentHost = detectHostFromEnvironment\(\)/);
    assert.match(app, /setHostUi\(environmentHost\)/);
    assert.ok(app.indexOf("setHostUi(environmentHost)") < app.indexOf('hostCall("common.ping")'));
    assert.match(html, /class="[^"]*ae-only[^"]*"[^>]*id="effectCopyDetails"/);
});
