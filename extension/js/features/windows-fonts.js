"use strict";

var childProcess = require("child_process");

var FONT_KEYS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
];

function cleanFamilyName(value) {
  return String(value || "")
    .replace(/\s*\((?:TrueType|OpenType|All res)\)\s*$/i, "")
    .replace(/\s+(?:Bold|Italic|Oblique|Regular|Light|Medium|Semibold|Semi Bold|Black)\s*$/i, "")
    .trim();
}

function parseRegistryOutput(output) {
  var seen = {};
  var fonts = [];
  String(output || "").split(/\r?\n/).forEach(function (line) {
    var match = /^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/.exec(line);
    if (!match) return;
    var family = cleanFamilyName(match[1]);
    if (!family || seen[family.toLowerCase()]) return;
    seen[family.toLowerCase()] = true;
    fonts.push({ postScriptName: family, familyName: family, source: match[2] });
  });
  return fonts.sort(function (a, b) { return a.familyName.localeCompare(b.familyName); });
}

function scan(callback) {
  if (process.platform !== "win32") return process.nextTick(function () { callback(null, []); });
  var pending = FONT_KEYS.length;
  var output = "";
  var warnings = [];
  FONT_KEYS.forEach(function (key) {
    var child = childProcess.spawn("reg.exe", ["query", key], { shell: false, windowsHide: true });
    var stdout = [];
    var stderr = [];
    var completed = false;
    child.stdout.on("data", function (chunk) { stdout.push(chunk); });
    child.stderr.on("data", function (chunk) { stderr.push(chunk); });
    child.on("error", function (error) {
      if (completed) return;
      completed = true;
      warnings.push({ key: key, message: error.message });
      finish();
    });
    child.on("exit", function (code) {
      if (completed) return;
      completed = true;
      if (code === 0) output += Buffer.concat(stdout).toString("utf8") + "\n";
      else warnings.push({ key: key, message: Buffer.concat(stderr).toString("utf8").trim() || "reg.exe exited with " + code });
      finish();
    });
  });

  function finish() {
    pending -= 1;
    if (pending > 0) return;
    callback(null, { fonts: parseRegistryOutput(output), warnings: warnings });
  }
}

module.exports = { scan: scan, parseRegistryOutput: parseRegistryOutput, cleanFamilyName: cleanFamilyName };
