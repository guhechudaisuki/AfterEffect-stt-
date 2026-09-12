"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "../..");
const browserPath = process.env.LWS_BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const recorderSource = fs.readFileSync(path.join(root, "extension/js/features/ae-selection-recorder.js"), "utf8");
const featureSource = fs.readFileSync(path.join(root, "extension/js/features/composition-copy.js"), "utf8");

async function withPanel(run) {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 1400 } });
  try {
    await page.goto(pathToFileURL(path.join(root, "extension/index.html")).href + "?mock=AEFT");
    // Execute the shipping controller and shipping recorder against real DOM
    // buttons. Only the Adobe host boundary is replaced in this browser test.
    await page.addScriptTag({ content: "(function () { var module = { exports: {} };\n" + recorderSource + "\nwindow.TestSelectionRecorder = module.exports; }());" });
    await page.addScriptTag({ content: "(function () { var module = { exports: {} }; var require = function () { return window.TestSelectionRecorder; };\n" + featureSource + "\nwindow.createCompositionCopy = module.exports; }());" });
    await page.evaluate(async function () {
      window.calls = [];
      window.snapshots = [];
      window.infoRequests = [];
      window.copyRequests = [];
      window.deferInfo = false;
      window.testStatus = null;
      document.getElementById("enableSttInput").checked = false;
      document.getElementById("modelSelect").innerHTML = "<option>无模型</option>";
      document.getElementById("modelSelect").disabled = true;
      Array.prototype.forEach.call(document.querySelectorAll(".stt-feature"), function (element) { element.hidden = true; });
      document.getElementById("compositionCopyDetails").open = true;
      window.templateInfo = function (id) {
        return { data: { compId: id, name: "模板 " + id, signature: "sig-" + id, textLayers: [
          { compId: id, index: 1, name: "标题 " + id, path: [1], text: "模板原文" },
          { compId: id + 100, index: 2, name: "嵌套文字 " + id, path: [2, 1], text: "嵌套原文" }
        ] } };
      };
      window.feature = window.createCompositionCopy({
        document: document,
        bridge: { call: function (route, params, callback) { window.calls.push({ route: route, params: params }); window.snapshots.push(callback); } },
        hostCall: function (route, params) {
          window.calls.push({ route: route, params: params });
          if (route === "ae.comp.copy.list") return Promise.resolve({ data: { comps: [{ compId: 90, name: "模板 A", textLayerCount: 2 }, { compId: 91, name: "模板 B", textLayerCount: 2 }] } });
          if (route === "ae.aep.import") return Promise.resolve({ data: { comps: [{ compId: 701 }, { compId: 702 }] } });
          if (route === "ae.comp.copy.info") return window.deferInfo ? new Promise(function (resolve) { window.infoRequests.push({ compId: params.compId, resolve: resolve }); }) : Promise.resolve(window.templateInfo(params.compId));
          if (route === "ae.comp.copy.create") return new Promise(function (resolve, reject) { window.copyRequests.push({ resolve: resolve, reject: reject }); });
          return Promise.reject(new Error("Unexpected host route: " + route));
        },
        choosePath: function () { return "D:\\templates\\example.aep"; },
        setStatus: function (tone, title, detail) { window.testStatus = { tone: tone, title: title, detail: detail }; }
      });
      window.feature.setHost("AEFT");
      await window.feature.loadTemplates();
    });
    await run(page);
  } finally {
    await page.evaluate(function () { if (window.feature) window.feature.destroy(); }).catch(function () {});
    await browser.close();
  }
}

const browserOptions = { skip: !fs.existsSync(browserPath) };

test("composition copy runs independently with final selection order and no STT model", browserOptions, async function () {
  await withPanel(async function (page) {
    assert.equal(await page.locator("#compositionTemplateSelect").inputValue(), "", "template must not be automatically chosen");
    assert.equal(await page.locator("#copyCompositionButton").isDisabled(), true);
    await page.selectOption("#compositionTemplateSelect", "90");
    await page.waitForFunction(function () { return document.querySelectorAll(".composition-template-row").length === 2; });
    await page.evaluate(function () {
      document.getElementById("recordCompositionSourcesButton").click();
      document.getElementById("recordCompositionSourcesButton").click();
    });
    assert.match(await page.locator("#recordCompositionSourcesButton").textContent(), /正在结束/);
    assert.equal(await page.locator("#chooseCompositionAepButton").isDisabled(), true);
    await page.evaluate(function () {
      window.sourceRows = ["A", "B", "C", "D", "E"].map(function (name, index) { return { compId: 11, layerId: "session-" + name, index: index + 1, name: name, isText: true }; });
      window.snapshots.shift()(null, { compId: 11, layers: window.sourceRows.slice(0, 4).concat([{ compId: 11, layerId: "footage", index: 0, name: "视频", isText: false }]) });
    });
    await page.waitForFunction(function () { return window.snapshots.length === 1; });
    assert.equal(await page.locator("#copyCompositionButton").isDisabled(), true, "final snapshot is still pending");
    await page.evaluate(function () { window.snapshots.shift()(null, { compId: 11, layers: window.sourceRows }); });
    await page.waitForFunction(function () { return document.getElementById("recordCompositionSourcesButton").getAttribute("aria-pressed") === "false"; });
    assert.equal(await page.locator("#compositionSourceList li").count(), 5);
    assert.match(await page.locator("#compositionCopyHint").textContent(), /5 个来源文字层.*3 个合成副本/);
    await page.getByRole("button", { name: "上移 E", exact: true }).click();
    await page.locator("#copyCompositionButton").click();
    assert.equal(await page.locator("#recordCompositionSourcesButton").isDisabled(), true);
    assert.equal(await page.locator("#compositionTemplateSelect").isDisabled(), true);
    const create = await page.evaluate(function () { return window.calls.filter(function (item) { return item.route === "ae.comp.copy.create"; }); });
    assert.deepEqual(create, [{ route: "ae.comp.copy.create", params: {
      sourceCompId: 11, targetCompId: 11, sourceLayerIds: ["session-A", "session-B", "session-C", "session-E", "session-D"], templateCompId: 90, templateSignature: "sig-90"
    } }]);
    assert.equal(await page.evaluate(function () { return window.calls.some(function (item) { return /stt|transcription|subtitles\.create|modules\.copy/.test(item.route); }); }), false);
    await page.evaluate(function () { window.copyRequests.shift().resolve({ data: { count: 3, sourceTextCount: 5, templateTextLayerCount: 2 }, envelope: { warnings: [] } }); });
    await page.waitForFunction(function () { return !!window.testStatus; });
    assert.equal(await page.evaluate(function () { return window.testStatus.title; }), "合成复制完成");
  });
});

test("composition template changes ignore stale detail responses", browserOptions, async function () {
  await withPanel(async function (page) {
    await page.evaluate(function () { window.deferInfo = true; });
    await page.selectOption("#compositionTemplateSelect", "90");
    await page.selectOption("#compositionTemplateSelect", "91");
    await page.evaluate(function () { window.infoRequests[1].resolve(window.templateInfo(91)); });
    await page.waitForFunction(function () { return document.getElementById("compositionTemplateLayers").textContent.indexOf("标题 91") >= 0; });
    await page.evaluate(function () { window.infoRequests[0].resolve(window.templateInfo(90)); });
    const current = await page.locator("#compositionTemplateLayers").textContent();
    assert.match(current, /标题 91/);
    assert.doesNotMatch(current, /标题 90/);
    await page.selectOption("#compositionTemplateSelect", "");
    assert.equal(await page.locator("#copyCompositionButton").isDisabled(), true);
    assert.match(await page.locator("#compositionTemplateLayers").textContent(), /选择模板后/);
  });
});

test("AEP import scopes the independent template list and keeps an explicit choice", browserOptions, async function () {
  await withPanel(async function (page) {
    await page.locator("#chooseCompositionAepButton").click();
    await page.waitForFunction(function () { return !document.getElementById("chooseCompositionAepButton").disabled; });
    const calls = await page.evaluate(function () { return window.calls.slice(-2); });
    assert.deepEqual(calls, [
      { route: "ae.aep.import", params: { path: "D:\\templates\\example.aep" } },
      { route: "ae.comp.copy.list", params: { compIds: [701, 702] } }
    ]);
    assert.equal(await page.locator("#compositionTemplateSelect").inputValue(), "");
    await page.evaluate(function () { window.feature.setHost("PPRO"); });
    assert.equal(await page.locator("#compositionCopyDetails").isVisible(), false);
    assert.equal(await page.locator("#recordCompositionSourcesButton").isDisabled(), true);
  });
});

test("expanding independent composition copy pushes following controls downward", browserOptions, async function () {
  await withPanel(async function (page) {
    const positions = await page.evaluate(function () {
      var panel = document.getElementById("compositionCopyDetails");
      panel.open = false;
      var before = panel.getBoundingClientRect();
      panel.open = true;
      panel.querySelector(".tool-body").style.minHeight = "700px";
      var after = panel.getBoundingClientRect();
      var next = document.getElementById("transcriptionDetails").getBoundingClientRect();
      return { before: before.top, after: after.top, bottom: after.bottom, next: next.top, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    assert.ok(Math.abs(positions.before - positions.after) <= 1);
    assert.ok(positions.next >= positions.bottom - 1);
    assert.equal(positions.overflow, false);
  });
});
