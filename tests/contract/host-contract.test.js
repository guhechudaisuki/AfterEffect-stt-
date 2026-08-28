const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workspace = path.resolve(__dirname, "../..");
const jsxRoot = path.join(workspace, "extension/jsx");
const files = {
    loader: path.join(jsxRoot, "host.jsx"),
    json: path.join(jsxRoot, "common/json2.jsx"),
    response: path.join(jsxRoot, "common/response.jsx"),
    keyframe: path.join(jsxRoot, "common/keyframe-time.jsx"),
    ae: path.join(jsxRoot, "AEFT/host.jsx"),
    pr: path.join(jsxRoot, "PPRO/host.jsx")
};

function read(name) {
    return fs.readFileSync(files[name], "utf8");
}

test("all JSX implementation files parse and avoid non-ES3 constructs", () => {
    const forbidden = [
        /\b(?:let|const|class|async|await)\b/,
        /=>/,
        /\.forEach\s*\(/,
        /\.map\s*\(/,
        /\.filter\s*\(/,
        /Object\.keys\s*\(/,
        /Array\.isArray\s*\(/
    ];
    for (const [name, file] of Object.entries(files)) {
        let source = fs.readFileSync(file, "utf8").replace(/^#targetengine[^\r\n]*[\r\n]+/, "");
        assert.doesNotThrow(() => new Function(source), `${name} must be syntactically valid`);
        for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} contains ${pattern}`);
    }
});

test("loader evaluates every common dependency before the host adapter", () => {
    const source = read("loader");
    assert.doesNotMatch(source, /^#targetengine\b/m, "CEP ScriptPath loader must not use a targetengine preprocessor directive");
    const jsonIndex = source.indexOf("common/json2.jsx");
    const responseIndex = source.indexOf("common/response.jsx");
    const keyframeIndex = source.indexOf("common/keyframe-time.jsx");
    const aeIndex = source.indexOf("AEFT/host.jsx");
    assert.ok(jsonIndex >= 0 && responseIndex > jsonIndex && keyframeIndex > responseIndex && aeIndex > keyframeIndex);
});

test("host files register the complete public route contract", () => {
    const aeRoutes = [
        "common.capabilities", "ae.context.get", "ae.range.get", "ae.audio.export", "ae.fonts.list",
        "ae.selection.snapshot", "ae.aep.import", "ae.aep.listComps", "ae.comp.listTextLayers",
        "ae.layer.tree", "ae.subtitles.create", "ae.modules.copy"
    ];
    const prRoutes = [
        "common.capabilities", "pr.context.get", "pr.range.get", "pr.audio.export", "pr.tracks.list",
        "pr.subtitles.graphics.create", "pr.subtitles.captions.create"
    ];
    for (const route of aeRoutes) assert.match(read("ae"), new RegExp(`register\\("${route.replaceAll(".", "\\.")}"`));
    for (const route of prRoutes) assert.match(read("pr"), new RegExp(`register\\("${route.replaceAll(".", "\\.")}"`));
    assert.match(read("response"), /register\("common\.ping"/);
});

test("dispatcher always returns a JSON envelope and enforces Adobe 2020+", () => {
    const context = {
        $: {},
        app: { version: "17.0.0", name: "Adobe After Effects" },
        BridgeTalk: { appName: "aftereffects" },
        JSON: undefined,
        Date,
        Error,
        Math,
        Number,
        Object,
        String,
        decodeURIComponent
    };
    vm.runInNewContext(read("json"), context, { filename: "json2.jsx" });
    vm.runInNewContext(read("response"), context, { filename: "response.jsx" });
    context.$._LWS.register("test.echo", (params) => ({ data: params }));
    const request = encodeURIComponent('{"apiVersion":"1.0","requestId":"r1","params":{"value":7}}');
    let response = JSON.parse(context.$._LWS.dispatch("test.echo", request));
    assert.equal(response.ok, true);
    assert.equal(response.requestId, "r1");
    assert.equal(response.data.value, 7);
    assert.equal(response.meta.host, "AEFT");

    context.app.version = "16.9.0";
    response = JSON.parse(context.$._LWS.dispatch("test.echo", request));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "VERSION_UNSUPPORTED");

    context.app.version = "25.7.0";
    response = JSON.parse(context.$._LWS.dispatch("test.echo", request));
    assert.equal(response.ok, true);

    context.app.version = "17.0.0";
    response = JSON.parse(context.$._LWS.dispatch("test.echo", encodeURIComponent('{"apiVersion":"1.0","requestId":"bad-params","params":[]}')));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_REQUEST");
});

test("JSON fallback emits valid JSON for controls and non-finite numbers", () => {
    const context = { JSON: undefined, Object, String, isFinite };
    vm.runInNewContext(read("json"), context, { filename: "json2.jsx" });
    const encoded = context.JSON.stringify({ text: "a\u0000b\n", value: Infinity });
    assert.deepEqual(JSON.parse(encoded), { text: "a\u0000b\n", value: null });
});

test("AE copy contract uses normalized key time and duration-scaled temporal speed", () => {
    const source = read("ae");
    assert.match(source, /\$\._LWS\.mapKeyTime\(key\.time, sourceLayer\.inPoint, sourceLayer\.outPoint, targetLayer\.inPoint, targetLayer\.outPoint\)/);
    assert.match(source, /\$\._LWS\.scaleTemporalSpeed/);
    assert.match(source, /params\.sources\[i % params\.sources\.length\]/);
    assert.match(source, /for \(i = effects\.numProperties; i >= 1; i -= 1\)/);
    assert.match(source, /var copyAll = moduleIds === undefined \|\| moduleIds === null/);
    assert.match(source, /AE_COPY_TARGET_IS_SOURCE/);
    assert.match(source, /transport: "jsonFile"/);
    assert.match(source, /transport: "inline"/);
    assert.match(source, /音频导出范围超出合成时长/);
    assert.match(source, /AE_LAYER_INDEX_MAPPING_UNAVAILABLE/);
    assert.match(source, /AE_MASK_INDEX_MAPPING_UNAVAILABLE/);
});

test("AE audio export reads a source media file without a custom output-module template", () => {
    const source = read("ae");
    const start = source.indexOf('$._LWS.register("ae.audio.export"');
    const end = source.indexOf('$._LWS.register("ae.subtitles.create"', start);
    const audioRoute = source.slice(start, end);
    assert.doesNotMatch(audioRoute, /LocalWhisper_AudioOnly/);
    assert.doesNotMatch(audioRoute, /applyTemplate/);
    assert.doesNotMatch(audioRoute, /renderQueue|rq\.items|\.render\(\)/);
    assert.match(audioRoute, /hasAudio/);
    assert.match(audioRoute, /sourceStartMs/);
});

test("Premiere contract uses stable MOGRT IDs and the five-argument encoder API", () => {
    const source = read("pr");
    assert.match(source, /setMogrtParam\(component, \["LWS_TEXT"\]/);
    assert.doesNotMatch(source, /"Source Text"|"源文本"/);
    assert.match(source, /encodeSequence\(seq, params\.outputPath, preset\.fsName, app\.encoder\.ENCODE_IN_TO_OUT, 1\)/);
    assert.match(source, /var startAtTime = Number\(params\.startSeconds \|\| 0\)/);
    assert.doesNotMatch(source, /createCaptionTrack\(projectItem, timeFromSeconds/);
    assert.match(source, /if \(clip\) clip\.remove\(\)/);
});

test("manual Adobe smoke scripts cover AE stretch and Premiere MOGRT parameter probes", () => {
    const aeSmoke = fs.readFileSync(path.join(workspace, "tools/ae-smoke-test.jsx"), "utf8");
    const prSmoke = fs.readFileSync(path.join(workspace, "tools/pr-smoke-panel/pr-mogrt-smoke-test.jsx"), "utf8");
    assert.match(aeSmoke, /layer-stretch-normalizes-template-keys/);
    assert.match(prSmoke, /getParamForDisplayName\("LWS_TEXT"\)/);
    assert.match(prSmoke, /if \(clip\) clip\.remove\(\)/);
    assert.doesNotThrow(() => new Function(aeSmoke.replace(/^#target[^\r\n]*[\r\n]+/, "")));
    assert.doesNotThrow(() => new Function(prSmoke.replace(/^#target[^\r\n]*[\r\n]+/, "")));
});
