"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var url = require("url");
var chromium = require("playwright-core").chromium;

var root = path.resolve(__dirname, "..", "..");
var edge = process.env.LWS_BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
var cases = [
  { name: "ae-320x520", host: "AEFT", width: 320, height: 520 },
  { name: "pr-380x720", host: "PPRO", width: 380, height: 720 },
  { name: "ae-templates-800x900", host: "AEFT", view: "templates", width: 800, height: 900 },
  { name: "ae-effects-960x900", host: "AEFT", view: "effects", width: 960, height: 900 },
  { name: "pr-1200x900", host: "PPRO", width: 1200, height: 900 },
  { name: "ae-fullwidth-1600x900", host: "AEFT", width: 1600, height: 900 }
];

test("CEP panel mock states render without horizontal overflow", { skip: !fs.existsSync(edge) }, async function () {
  var browser = await chromium.launch({ executablePath: edge, headless: true });
  var output = path.join(root, "artifacts", "ui");
  fs.mkdirSync(output, { recursive: true });
  try {
    for (var i = 0; i < cases.length; i += 1) {
      var item = cases[i];
      var page = await browser.newPage({ viewport: { width: item.width, height: item.height }, deviceScaleFactor: 1 });
      var target = url.pathToFileURL(path.join(root, "extension", "index.html")).href + "?mock=" + item.host + (item.view ? "&view=" + item.view : "");
      await page.goto(target);
      await page.waitForFunction(function () { return document.getElementById("statusTitle").textContent === "本地模型可用"; });
      if (item.view === "templates") await page.locator("#templateDetails").scrollIntoViewIfNeeded();
      if (item.view === "effects") await page.locator("#effectCopyDetails").scrollIntoViewIfNeeded();
      var metrics = await page.evaluate(function () {
        var footer = document.querySelector(".run-section").getBoundingClientRect();
        var shell = document.querySelector(".panel-shell").getBoundingClientRect();
        var visible = Array.prototype.filter.call(document.querySelectorAll(".control-section, .host-tool"), function (element) { return !element.hidden && element.offsetParent !== null; });
        var overlaps = [];
        for (var a = 0; a < visible.length; a += 1) for (var b = a + 1; b < visible.length; b += 1) {
          var first = visible[a].getBoundingClientRect();
          var second = visible[b].getBoundingClientRect();
          if (Math.min(first.right, second.right) - Math.max(first.left, second.left) > 2 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 2) overlaps.push([visible[a].id || visible[a].className, visible[b].id || visible[b].className]);
        }
        return {
          viewportWidth: document.documentElement.clientWidth,
          pageWidth: document.documentElement.scrollWidth,
          footerBottom: footer.bottom,
          footerWidth: footer.width,
          shellLeft: shell.left,
          shellWidth: shell.width,
          title: document.getElementById("statusTitle").textContent,
          overlaps: overlaps
        };
      });
      assert.equal(metrics.pageWidth, metrics.viewportWidth, item.name + " has horizontal overflow");
      assert.ok(metrics.footerBottom <= item.height + 1, item.name + " footer leaves the viewport");
      assert.ok(metrics.footerWidth <= item.width + 1, item.name + " footer is wider than the viewport");
      assert.ok(Math.abs(metrics.footerWidth - item.width) <= 1, item.name + " footer does not fill the viewport");
      assert.ok(Math.abs(metrics.shellLeft) <= 1 && Math.abs(metrics.shellWidth - item.width) <= 1, item.name + " panel does not fill the viewport");
      assert.deepEqual(metrics.overlaps, [], item.name + " has overlapping panels");
      var screenshot = path.join(output, item.name + ".png");
      await page.screenshot({ path: screenshot });
      assert.ok(fs.statSync(screenshot).size > 10000, item.name + " screenshot is unexpectedly blank");
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("expanding the AE template tool keeps it in the upper-right flow", { skip: !fs.existsSync(edge) }, async function () {
  var browser = await chromium.launch({ executablePath: edge, headless: true });
  var page = await browser.newPage({ viewport: { width: 800, height: 1400 }, deviceScaleFactor: 1 });
  try {
    var target = url.pathToFileURL(path.join(root, "extension", "index.html")).href + "?mock=AEFT";
    await page.goto(target);
    await page.waitForFunction(function () { return document.getElementById("templateDetails") && !document.getElementById("templateDetails").hidden; });
    await page.waitForTimeout(180);
    var before = await page.evaluate(function () {
      var template = document.getElementById("templateDetails");
      return { templateTop: template.getBoundingClientRect().top, transcriptionTop: document.getElementById("transcriptionDetails").getBoundingClientRect().top };
    });
    await page.evaluate(function () {
      var template = document.getElementById("templateDetails");
      template.open = true;
      template.querySelector(".tool-body").style.minHeight = "700px";
      template.dispatchEvent(new Event("toggle"));
    });
    await page.waitForTimeout(250);
    var after = await page.evaluate(function () {
      var template = document.getElementById("templateDetails");
      var transcription = document.getElementById("transcriptionDetails");
      return { templateTop: template.getBoundingClientRect().top, templateBottom: template.getBoundingClientRect().bottom, transcriptionTop: transcription.getBoundingClientRect().top };
    });
    assert.ok(Math.abs(after.templateTop - before.templateTop) <= 1, "template panel jumped when expanded");
    assert.ok(after.transcriptionTop >= after.templateBottom - 1, "following controls did not yield to expanded template");
  } finally {
    await page.close();
    await browser.close();
  }
});
