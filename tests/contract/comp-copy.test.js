"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "extension/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "extension/js/app.js"), "utf8");
const loader = fs.readFileSync(path.join(root, "extension/jsx/host.jsx"), "utf8");
const compCopy = fs.readFileSync(path.join(root, "extension/jsx/AEFT/comp-copy.jsx"), "utf8");

test("comp-copy module parses and stays ExtendScript ES3", () => {
  const forbidden = [
    /\b(?:let|const|class|async|await)\b/,
    /=>/,
    /\.forEach\s*\(/,
    /\.map\s*\(/,
    /\.filter\s*\(/,
    /Object\.keys\s*\(/,
    /Array\.isArray\s*\(/
  ];
  assert.doesNotThrow(() => new Function(compCopy), "comp-copy.jsx must be syntactically valid");
  for (const pattern of forbidden) assert.doesNotMatch(compCopy, pattern, `comp-copy.jsx contains ${pattern}`);
});

test("comp-copy registers additive routes without touching the existing contract", () => {
  assert.match(compCopy, /register\("ae\.comp\.templateInfo"/);
  assert.match(compCopy, /register\("ae\.comp\.subtitles\.create"/);
  const existing = [
    "common.capabilities", "ae.context.get", "ae.range.get", "ae.audio.export", "ae.fonts.list",
    "ae.selection.snapshot", "ae.aep.import", "ae.aep.listComps", "ae.comp.listTextLayers",
    "ae.layer.tree", "ae.subtitles.create", "ae.modules.copy"
  ];
  for (const route of existing) {
    assert.doesNotMatch(compCopy, new RegExp(`register\\("${route.replaceAll(".", "\\.")}"`), `comp-copy must not re-register ${route}`);
  }
});

test("bootstrap loads the comp-copy module for AEFT after the main host adapter", () => {
  const aeIndex = loader.indexOf("AEFT/host.jsx");
  const compIndex = loader.indexOf("AEFT/comp-copy.jsx");
  assert.ok(aeIndex >= 0 && compIndex > aeIndex, "comp-copy.jsx must load after AEFT/host.jsx");
});

test("rhythm driving follows the documented three-tier contract", () => {
  assert.match(compCopy, /"ADBE Slider Control-0001"/, "slider driver must read the slider value property");
  assert.match(compCopy, /"ADBE Slider Control"/);
  assert.match(compCopy, /\/lws\/i\.test\(name\)/);
  assert.match(compCopy, /name\.indexOf\("进度"\)/);
  assert.match(compCopy, /"ADBE Text Selector Start"/);
  assert.match(compCopy, /"ADBE Text Selector Offset"/);
  assert.match(compCopy, /KeyframeInterpolationType\.LINEAR/);
  assert.match(compCopy, /W_COMP_TEMPLATE_LINEAR_TIMING/);
});

test("word timestamps drive progress keys inside the duplicated comp", () => {
  assert.match(compCopy, /segment\.words/);
  assert.match(compCopy, /segment\.relativeStartMs/);
  assert.match(compCopy, /var time = spanIn \+ \(keys\[i\]\.offsetMs \/ 1000\) \* spanSeconds \/ segmentSeconds;/);
  assert.match(compCopy, /prop\.setValueAtTime\(time, keys\[i\]\.value\);/);
  assert.match(compCopy, /removeKeys\(prop\);/);
});

test("stamping duplicates the template comp and maps it onto the segment", () => {
  assert.match(compCopy, /template\.duplicate\(\)/);
  assert.match(compCopy, /var stretch = \(segmentSeconds \/ spanSeconds\) \* 100;/);
  assert.match(compCopy, /placed\.startTime = start - span\.inPoint \* stretch \/ 100;/);
  assert.match(compCopy, /comp\.layers\.add\(dup\)/);
  assert.match(compCopy, /app\.beginUndoGroup\("LWS 合成模板字幕"\)/);
  assert.match(compCopy, /AE_COMP_STAMP_FAILED/);
  assert.match(compCopy, /W_COMP_TEMPLATE_SCALED/);
  assert.match(compCopy, /W_COMP_TEMPLATE_AUDIO_DISABLED/);
  assert.match(compCopy, /LWS 合成模板/);
});

test("panel exposes a comp-template output mode behind the existing modes", () => {
  const compMode = html.indexOf('data-output="compTemplate"');
  const perSegment = html.indexOf('data-output="perSegmentLayers"');
  const singleLayer = html.indexOf('data-output="singleLayer"');
  assert.ok(perSegment >= 0 && singleLayer > perSegment && compMode > singleLayer, "comp template button must follow the existing AE modes");
  const details = html.indexOf('id="compTemplateDetails"');
  assert.ok(details >= 0, "comp template settings section is missing");
  assert.match(html, /<details class="host-tool ae-only stt-feature" id="compTemplateDetails" hidden>/);
  assert.match(html, /id="compTemplateSelect"/);
  assert.match(html, /id="refreshCompTemplateButton"/);
  assert.match(html, /id="compTemplateTextLayers"/);
  assert.match(html, /id="compTemplateTiming"/);
  assert.match(html, /LWS Progress/);
});

test("app.js routes comp-template mode to the new host route with word-timed segments", () => {
  assert.match(app, /state\.outputMode === "compTemplate"/);
  assert.match(app, /hostCall\("ae\.comp\.subtitles\.create", \{ compId: state\.context\.activeComp\.itemId, segmentsFile: result\.artifacts\.json, templateCompId: state\.compTemplate\.compId, textLayerIds: state\.compTemplate\.textLayerIds, displayLanguages: displayLanguages\(\), layerPrefix: "LWS 合成字幕" \}\)/);
  assert.match(app, /function updateCompTemplateVisibility\(\)/);
  assert.match(app, /updateCompTemplateVisibility\(\);\s*updateReadyState\(\);/);
  assert.match(app, /byId\("compTemplateSelect"\)\.addEventListener\("change", onCompTemplateChange\)/);
  assert.match(app, /byId\("refreshCompTemplateButton"\)\.addEventListener\("click", loadCompTemplateList\)/);
  assert.match(app, /if \(state\.host === "AEFT"\) loadCompTemplateList\(\);/);
  assert.match(app, /合成模板未配置/);
  assert.match(app, /ae\.comp\.templateInfo/);
});

test("existing transcription flow keeps calling the original subtitle route", () => {
  assert.match(app, /hostCall\("ae\.subtitles\.create"/);
  assert.match(app, /hostCall\("ae\.modules\.copy"/);
});
