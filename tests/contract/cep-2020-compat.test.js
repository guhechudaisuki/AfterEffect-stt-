const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspace = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(workspace, relativePath), "utf8");

test("CEP 9 browser payload avoids syntax and APIs missing from its Chromium runtime", () => {
  const lucide = read("extension/vendor/lucide.min.js");
  assert.doesNotMatch(lucide, /\?\./, "optional chaining prevents the vendor script from parsing in CEP 9");
  assert.doesNotMatch(lucide, /\.flatMap\(/, "Array.flatMap is unavailable in CEP 9");
});

test("CEP 9 Node payload does not depend on recursive mkdir options", () => {
  const app = read("extension/js/app.js");
  const store = read("extension/js/core/temp-job-store.js");
  assert.doesNotMatch(app, /mkdirSync\([^\n]+recursive/);
  assert.match(store, /module\.exports = \{[^}]*ensureDirectory: ensureDirectory/);
  assert.match(app, /tempStore\.ensureDirectory\(/);
});
