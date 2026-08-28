"use strict";

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var root = path.resolve(__dirname, "..");
var roots = ["extension/js", "tests", "tools"];
var files = [];

function walk(directory) {
  fs.readdirSync(directory).forEach(function (name) {
    var target = path.join(directory, name);
    var stat = fs.statSync(target);
    if (stat.isDirectory()) walk(target);
    else if (/\.js$/i.test(name)) files.push(target);
  });
}

roots.forEach(function (relative) {
  var directory = path.join(root, relative);
  if (fs.existsSync(directory)) walk(directory);
});

var failed = [];
files.forEach(function (file) {
  var result = childProcess.spawnSync(process.execPath, ["--check", file], { shell: false, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) failed.push({ file: file, output: result.stderr || result.stdout });
});

if (failed.length) {
  failed.forEach(function (failure) {
    process.stderr.write(path.relative(root, failure.file) + "\n" + failure.output + "\n");
  });
  process.exit(1);
}

process.stdout.write("Checked " + files.length + " JavaScript files\n");
