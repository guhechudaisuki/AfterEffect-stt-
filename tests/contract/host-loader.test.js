const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workspace = path.resolve(__dirname, "../..");
const loader = fs.readFileSync(path.join(workspace, "extension/jsx/host.jsx"), "utf8");

function makeFailingExtendScriptContext() {
    function FakeFile(value) {
        this.fsName = String(value || "");
        this.parent = { fsName: path.dirname(this.fsName) };
        this.exists = true;
    }

    const context = {
        $: {
            fileName: path.join(workspace, "extension/jsx/host.jsx"),
            evalFile: function () { throw new Error("dependency load failed"); }
        },
        File: FakeFile,
        BridgeTalk: { appName: "aftereffects" },
        app: { version: "25.6.1", name: "Adobe After Effects" },
        Error,
        JSON: undefined,
        String,
        Object,
        Date,
        Math,
        Number,
        decodeURIComponent
    };
    vm.createContext(context);
    return context;
}

test("host loader keeps a diagnostic dispatch when a dependency fails", () => {
    const context = makeFailingExtendScriptContext();
    vm.runInContext(loader.replace(/^#targetengine[^\r\n]*[\r\n]+/, ""), context, { filename: "host.jsx" });
    assert.equal(typeof context.$._LWS.dispatch, "function");
    const response = JSON.parse(context.$._LWS.dispatch("common.bootstrapStatus", ""));
    assert.equal(response.ok, false);
    assert.match(response.error.code, /BOOTSTRAP/);
    assert.ok(response.error.details.attempted.length >= 1);
});

test("host loader can recover when CEP supplies the extension root explicitly", () => {
    const actualRoot = path.join(workspace, "extension", "jsx").replace(/\\/g, "/");
    const loaded = [];
    function FakeFile(value) {
        this.fsName = String(value || "").replace(/\\/g, "/");
        this.path = this.fsName.substring(0, this.fsName.lastIndexOf("/"));
        this.parent = { fsName: this.path };
        this.exists = this.fsName.indexOf(actualRoot + "/") === 0 && (
            this.fsName.indexOf("/common/json2.jsx") >= 0 ||
            this.fsName.indexOf("/common/response.jsx") >= 0 ||
            this.fsName.indexOf("/common/keyframe-time.jsx") >= 0 ||
            this.fsName.indexOf("/AEFT/host.jsx") >= 0 ||
            this.fsName.indexOf("/AEFT/comp-copy.jsx") >= 0
        );
    }
    const context = {
        $: {
            fileName: "C:/Adobe/Support Files/host.jsx",
            evalFile: function (file) {
                loaded.push(file.fsName);
                if (file.fsName.indexOf("/common/response.jsx") >= 0) {
                    context.$._LWS.dispatch = function () { return "{}"; };
                    context.$._LWS.register = function () {};
                }
            }
        },
        File: FakeFile,
        Folder: { current: { fsName: "C:/Adobe/Support Files" } },
        BridgeTalk: { appName: "aftereffects" },
        app: { version: "25.6.1", name: "Adobe After Effects" },
        Error,
        JSON: undefined,
        String,
        Object,
        Date,
        Math,
        Number,
        decodeURIComponent,
        encodeURIComponent
    };
    vm.createContext(context);
    vm.runInContext(loader, context, { filename: "host.jsx" });
    const result = JSON.parse(context.$._LWS.bootstrapFromRoot(encodeURIComponent(actualRoot)));
    assert.equal(result.ok, true);
    assert.equal(result.data.root, actualRoot);
    assert.ok(loaded.some(function (value) { return value.indexOf("/common/json2.jsx") >= 0; }));
});
