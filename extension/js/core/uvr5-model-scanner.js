"use strict";

var fs = require("fs");
var path = require("path");
var modelScanner = require("./model-scanner");
var errors = require("./errors");

var WEIGHT_EXTENSIONS = { ".pth": true };
var IGNORED = { "$recycle.bin": true, "system volume information": true, "node_modules": true, ".git": true, "windows": true, "programdata": true, "__pycache__": true };

function nextTurn(callback) { return typeof setImmediate === "function" ? setImmediate(callback) : setTimeout(callback, 0); }
function existsFile(value) { try { return !!value && fs.statSync(value).isFile(); } catch (ignore) { return false; } }
function real(value) { try { return fs.realpathSync(value); } catch (ignore) { return path.resolve(value); } }

function findUvrRoot(weightPath) {
  var current = path.dirname(weightPath);
  for (var depth = 0; depth < 7; depth += 1) {
    if (existsFile(path.join(current, "vr.py")) && existsFile(path.join(current, "lib", "lib_v5", "model_param_init.py"))) return current;
    var parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findPython(uvrRoot) {
  if (!uvrRoot) return null;
  var candidates = [
    path.join(uvrRoot, "..", "..", "runtime", "python.exe"),
    path.join(uvrRoot, "..", "..", "python.exe"),
    path.join(uvrRoot, "..", "..", ".venv", "Scripts", "python.exe"),
    path.join(uvrRoot, "..", "..", "venv", "Scripts", "python.exe")
  ];
  for (var index = 0; index < candidates.length; index += 1) if (existsFile(candidates[index])) return real(candidates[index]);
  return null;
}

function makeModel(filePath, hints) {
  hints = hints || {};
  var uvrRoot = hints.uvrRoot && existsFile(path.join(hints.uvrRoot, "vr.py")) ? real(hints.uvrRoot) : findUvrRoot(filePath);
  var pythonExecutable = hints.pythonExecutable && existsFile(hints.pythonExecutable) ? real(hints.pythonExecutable) : findPython(uvrRoot);
  var stat = fs.statSync(filePath);
  var resolved = real(filePath);
  return {
    id: "uvr5:" + resolved.toLowerCase(),
    displayName: path.basename(resolved, path.extname(resolved)),
    path: resolved,
    uvrRoot: uvrRoot ? real(uvrRoot) : null,
    pythonExecutable: pythonExecutable,
    sizeBytes: stat.size,
    compatible: !!uvrRoot && !!pythonExecutable,
    status: uvrRoot && pythonExecutable ? "ready" : "missingRuntime"
  };
}

function modelsInWeightDirectory(directory, hints) {
  var models = [];
  try {
    fs.readdirSync(directory).forEach(function (name) {
      var filePath = path.join(directory, name);
      if (WEIGHT_EXTENSIONS[path.extname(name).toLowerCase()] && existsFile(filePath)) {
        try { models.push(makeModel(filePath, hints)); } catch (ignoreModel) {}
      }
    });
  } catch (ignoreDirectory) {}
  return models;
}

function priorityModels(target) {
  var models = [];
  var manifestPath = path.join(target, "voice_extractor_installation.json");
  if (existsFile(manifestPath)) try {
    var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    var weightRoot = manifest.assets && manifest.assets.uvr_model;
    models = models.concat(modelsInWeightDirectory(weightRoot, { uvrRoot: manifest.uvr_code, pythonExecutable: manifest.python }));
  } catch (ignoreManifest) {}
  var candidates = [
    path.join(target, "tools", "uvr5", "uvr5_weights"),
    path.join(target, "uvr5", "uvr5_weights"),
    path.join(target, "uvr5_weights")
  ];
  candidates.forEach(function (directory) { models = models.concat(modelsInWeightDirectory(directory)); });
  return models;
}

function scanRoots(roots, options, callback) {
  options = options || {};
  var queue = roots.map(function (root) { return { path: path.resolve(root), depth: 0 }; });
  var visited = {};
  var models = options.initialModels ? options.initialModels.slice() : [];
  var warnings = [];
  var entries = 0;
  var maxDepth = options.maxDepth === undefined ? 12 : options.maxDepth;
  var maxEntries = options.maxEntries || 300000;
  function finish(error) {
    var seen = {};
    models = models.filter(function (model) { if (seen[model.id]) return false; seen[model.id] = true; return true; });
    callback(error, { models: models, warnings: warnings, entries: entries, complete: !queue.length });
  }
  function step() {
    if (!queue.length || entries >= maxEntries) return finish(null);
    var item = queue.shift();
    fs.lstat(item.path, function (statError, stat) {
      if (statError) { if (statError.code !== "ENOENT") warnings.push({ code: "W_SCAN_ACCESS_DENIED", path: item.path }); return nextTurn(step); }
      entries += 1;
      if (stat.isSymbolicLink && stat.isSymbolicLink()) return nextTurn(step);
      if (stat.isFile && stat.isFile()) {
        if (WEIGHT_EXTENSIONS[path.extname(item.path).toLowerCase()] && stat.size > 0) {
          try {
            var model = makeModel(item.path);
            if (model.uvrRoot) models.push(model);
          } catch (ignoreModel) {}
        }
        return nextTurn(step);
      }
      if (!stat.isDirectory || !stat.isDirectory() || item.depth > maxDepth) return nextTurn(step);
      var resolved = real(item.path); var key = resolved.toLowerCase();
      if (visited[key]) return nextTurn(step); visited[key] = true;
      fs.readdir(resolved, function (readError, names) {
        if (readError) { warnings.push({ code: "W_SCAN_ACCESS_DENIED", path: resolved }); return nextTurn(step); }
        if (item.depth < maxDepth) names.forEach(function (name) { if (!IGNORED[name.toLowerCase()]) queue.push({ path: path.join(resolved, name), depth: item.depth + 1 }); });
        nextTurn(step);
      });
    });
  }
  nextTurn(step);
}

function inspectSpecified(target, options, callback) {
  if (!target) return nextTurn(function () { callback(errors.makeError(errors.ERROR_CODES.SCAN_PATH_INVALID, "指定路径不能为空")); });
  fs.lstat(target, function (error, stat) {
    if (error) return callback(errors.makeError(errors.ERROR_CODES.SCAN_PATH_NOT_FOUND, "指定路径不存在", { path: target }));
    var scanOptions = Object.assign({ maxDepth: stat.isFile() ? 0 : 12 }, options || {});
    scanOptions.initialModels = stat.isDirectory() ? priorityModels(target) : [];
    scanRoots([target], scanOptions, callback);
  });
}

function scanModels(options, callback) {
  options = options || {};
  var roots = options.mode === "fullDisk" ? modelScanner.windowsDriveRoots() : (options.roots || []);
  scanRoots(roots, options, callback);
}

module.exports = { inspectSpecified: inspectSpecified, scanModels: scanModels, findUvrRoot: findUvrRoot, findPython: findPython, priorityModels: priorityModels };
