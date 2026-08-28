"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

function ensureDirectory(directory) {
  if (fs.existsSync(directory)) return directory;
  var parent = path.dirname(directory);
  if (parent && parent !== directory) ensureDirectory(parent);
  try { fs.mkdirSync(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return directory;
}

function containsPlaintextSecret(value) {
  var secretKey = /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)$/i;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsPlaintextSecret);
  return Object.keys(value).some(function (key) {
    return secretKey.test(key) || containsPlaintextSecret(value[key]);
  });
}

function create(baseDirectory, jobId) {
  var root = ensureDirectory(baseDirectory || path.join(os.tmpdir(), "LocalWhisperSubtitles"));
  var directory = path.join(root, String(jobId || randomId()).replace(/[^A-Za-z0-9_-]/g, "_") + "-" + randomId());
  ensureDirectory(directory);
  return {
    root: root,
    directory: directory,
    path: function (name) { return path.join(directory, name); },
    writeJsonAtomic: function (name, value) {
      if (containsPlaintextSecret(value)) throw new Error("Refusing to persist plaintext credential fields");
      if (typeof name !== "string" || name !== path.basename(name) || name.indexOf("\0") >= 0) throw new Error("Invalid temporary artifact name");
      var target = path.join(directory, name);
      var partial = target + ".partial";
      fs.writeFileSync(partial, JSON.stringify(value, null, 2), "utf8");
      fs.renameSync(partial, target);
      return target;
    },
    cleanup: function () { removeTree(directory); }
  };
}

function removeTree(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  fs.readdirSync(directory).forEach(function (name) {
    var target = path.join(directory, name);
    var stat;
    try { stat = fs.lstatSync(target); } catch (ignore) { return; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) removeTree(target);
    else { try { fs.unlinkSync(target); } catch (ignore) {} }
  });
  try { fs.rmdirSync(directory); } catch (ignore) {}
}

function cleanupOld(baseDirectory, maxAgeMs) {
  if (!fs.existsSync(baseDirectory)) return;
  var now = Date.now();
  fs.readdirSync(baseDirectory).forEach(function (name) {
    var target = path.join(baseDirectory, name);
    try {
      var stat = fs.statSync(target);
      if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) removeTree(target);
    } catch (ignore) {}
  });
}

module.exports = { create: create, cleanupOld: cleanupOld, removeTree: removeTree, containsPlaintextSecret: containsPlaintextSecret };
