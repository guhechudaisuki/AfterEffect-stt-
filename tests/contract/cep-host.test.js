const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const Bridge = require(path.resolve(__dirname, "../../extension/js/bridge/cep-host.js"));

test("CEP bridge surfaces bootstrap diagnostics after EvalScript error", async () => {
    const calls = [];
    const cep = {
        evalScript: function (script, callback) {
            calls.push(script);
            if (calls.length === 1) return callback("EvalScript error.");
            callback(JSON.stringify({
                ok: false,
                error: {
                    code: "HOST_BOOTSTRAP_FAILED",
                    message: "Adobe 宿主脚本未完成加载",
                    details: { errors: [{ stage: "common/response.jsx", error: "syntax error" }] }
                }
            }));
        }
    };
    const bridge = new Bridge(cep);
    await new Promise((resolve, reject) => {
        bridge.call("common.ping", {}, (error) => {
            try {
                assert.equal(error.code, "HOST_BOOTSTRAP_FAILED");
                assert.equal(calls.length, 2);
                assert.match(calls[1], /common\.bootstrapStatus/);
                resolve();
            } catch (assertionError) { reject(assertionError); }
        });
    });
});

test("CEP bridge reports a clear fallback when diagnostics are unavailable", async () => {
    const cep = { evalScript: function (_script, callback) { callback("EvalScript error."); } };
    const bridge = new Bridge(cep);
    await new Promise((resolve, reject) => {
        bridge.call("common.ping", {}, (error) => {
            try {
                assert.equal(error.code, "CEP_EVALSCRIPT_FAILED");
                assert.match(error.message, /完全退出并重新打开 Adobe/);
                resolve();
            } catch (assertionError) { reject(assertionError); }
        });
    });
});

test("CEP bridge can explicitly bootstrap the installed extension root", async () => {
    let script = "";
    const cep = { evalScript: function (value, callback) {
        script = value;
        callback(JSON.stringify({ ok: true, data: { root: "C:/Users/test/extension/jsx" } }));
    } };
    const bridge = new Bridge(cep);
    await new Promise((resolve, reject) => {
        bridge.bootstrapFromExtensionRoot("C:/Users/test/extension", (error, data) => {
            try {
                assert.equal(error, null);
                assert.equal(data.root, "C:/Users/test/extension/jsx");
                assert.match(script, /bootstrapFromRoot/);
                assert.match(script, /C%3A%2FUsers%2Ftest%2Fextension/);
                resolve();
            } catch (assertionError) { reject(assertionError); }
        });
    });
});
