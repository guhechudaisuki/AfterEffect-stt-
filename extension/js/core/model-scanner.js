"use strict";

var fs = require("fs");
var path = require("path");
var errors = require("./errors");

var MODEL_EXTENSIONS = { ".pt": true, ".bin": true, ".gguf": true };
var IGNORED_DIRS = {
  "$recycle.bin": true,
  "system volume information": true,
  "node_modules": true,
  ".git": true,
  "windows": true,
  "programdata": true,
  "recycle.bin": true,
  "browsercache": true
};

function nextTurn(callback) {
  if (typeof setImmediate === "function") return setImmediate(callback);
  return setTimeout(callback, 0);
}

function safeRealPath(value) {
  try { return fs.realpathSync(value); } catch (ignore) { return path.resolve(value); }
}

function legacyGgmlMagic(magic) {
  return magic === "lmgg" || magic === "ggml" || magic === "fmgg" || magic === "tjgg";
}

function fileSignature(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (ext === ".pt") {
    return { format: "openai-pt", confidence: "extension", trusted: false, requiresTrust: true };
  }
  var fd;
  var bytesRead = 0;
  var buffer = Buffer.alloc ? Buffer.alloc(32) : new Buffer(32);
  try {
    fd = fs.openSync(filePath, "r");
    bytesRead = fs.readSync(fd, buffer, 0, 32, 0);
  } catch (error) {
    return { format: "unknown", confidence: "unreadable", warning: error.code || "E_IO_DENIED" };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (ignore) {} }
  }
  if (bytesRead < 4) return { format: "unknown", confidence: "header" };
  var magic = buffer.toString("ascii", 0, 4);
  if (magic === "GGUF") return { format: "gguf", confidence: "header", trusted: null, requiresTrust: false };
  if (legacyGgmlMagic(magic)) return { format: "ggml-bin", confidence: "header", trusted: null, requiresTrust: false };
  return { format: "unknown", confidence: "header" };
}

function modelName(filePath) {
  return path.basename(filePath).replace(/\.(pt|bin|gguf)$/i, "");
}

function fileIdentity(stat, realPath) {
  if (stat && stat.dev !== undefined && stat.ino !== undefined && Number(stat.ino) !== 0) {
    return "inode:" + stat.dev + ":" + stat.ino + ":" + stat.size;
  }
  return "path:" + realPath.toLowerCase();
}

function makeFileModel(filePath, stat, signature, origin) {
  var real = safeRealPath(filePath);
  return {
    id: "file:" + real.toLowerCase(),
    identity: fileIdentity(stat, real),
    name: modelName(filePath),
    displayName: modelName(filePath),
    path: real,
    kind: "file",
    format: signature.format,
    confidence: signature.confidence,
    trusted: signature.trusted,
    requiresTrust: !!signature.requiresTrust,
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs !== undefined ? stat.mtimeMs : stat.mtime.getTime(),
    origin: origin || "scan",
    compatible: false,
    status: "discovered",
    warnings: signature.warning ? [signature.warning] : []
  };
}

function isIgnored(name) {
  return !!IGNORED_DIRS[String(name || "").toLowerCase()];
}

function defaultRoots(extensionRoot) {
  var env = process.env;
  var home = env.USERPROFILE || env.HOME || "";
  var roots = [
    env.WHISPER_MODEL_DIR,
    env.HF_HOME,
    home ? path.join(home, ".cache", "whisper") : null,
    home ? path.join(home, ".cache", "huggingface", "hub") : null,
    (env.LOCALAPPDATA || home) ? path.join(env.LOCALAPPDATA || home, "whisper") : null,
    (env.LOCALAPPDATA || home) ? path.join(env.LOCALAPPDATA || home, "LocalWhisperSubtitles", "models") : null,
    extensionRoot ? path.resolve(extensionRoot, "..", "..", "resources", "models") : null
  ];
  var seen = {};
  return roots.filter(function (value) {
    if (!value) return false;
    var key = path.resolve(value).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function windowsDriveRoots() {
  var roots = [];
  if (process.platform !== "win32") return [path.parse(process.cwd()).root || "/"];
  for (var code = 65; code <= 90; code += 1) {
    var root = String.fromCharCode(code) + ":\\";
    try { if (fs.existsSync(root)) roots.push(root); } catch (ignore) {}
  }
  return roots;
}

function addWarning(output, warning) {
  var key = warning.code + ":" + (warning.path || "") + ":" + (warning.limit || "");
  if (output.warningKeys[key]) return;
  output.warningKeys[key] = true;
  output.warnings.push(warning);
}

function inspectCTranslate2(directory, names, options, output) {
  var lowerNames = {};
  names.forEach(function (name) { lowerNames[String(name).toLowerCase()] = name; });
  if (!lowerNames["config.json"] || !lowerNames["model.bin"]) return;
  var hasTokenizer = names.some(function (name) { return /tokenizer|vocab|preprocessor/i.test(name); });
  if (!hasTokenizer) return;
  var configPath = path.join(directory, lowerNames["config.json"]);
  var modelPath = path.join(directory, lowerNames["model.bin"]);
  var configStat;
  var modelStat;
  try {
    configStat = fs.statSync(configPath);
    modelStat = fs.statSync(modelPath);
    if (!modelStat.isFile() || modelStat.size <= 0 || configStat.size > (options.maxConfigBytes || 1024 * 1024)) throw new Error("invalid CTranslate2 files");
    JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    addWarning(output, { code: "E_MODEL_CORRUPT", path: directory, reason: error.code || error.message });
    return;
  }
  var real = safeRealPath(directory);
  output.models.push({
    id: "ct2:" + real.toLowerCase(),
    identity: "ct2:" + real.toLowerCase(),
    name: path.basename(real),
    displayName: path.basename(real),
    path: real,
    kind: "directory",
    format: "ctranslate2",
    confidence: "directory-signature",
    trusted: null,
    requiresTrust: false,
    sizeBytes: modelStat.size,
    origin: options.origin || "scan",
    compatible: false,
    status: "discovered",
    warnings: []
  });
}

function inspectHuggingFaceWhisper(directory, names, options, output) {
  var lowerNames = {};
  names.forEach(function (name) { lowerNames[String(name).toLowerCase()] = name; });
  if (!lowerNames["config.json"] || !lowerNames["model.safetensors"] ||
      !lowerNames["preprocessor_config.json"] || !lowerNames["tokenizer.json"]) return;
  var configPath = path.join(directory, lowerNames["config.json"]);
  var modelPath = path.join(directory, lowerNames["model.safetensors"]);
  var config;
  var modelStat;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    modelStat = fs.statSync(modelPath);
    if (!modelStat.isFile() || modelStat.size <= 0 || config.model_type !== "whisper") throw new Error("invalid Hugging Face Whisper files");
  } catch (error) {
    addWarning(output, { code: "E_MODEL_CORRUPT", path: directory, reason: error.code || error.message });
    return;
  }
  var real = safeRealPath(directory);
  output.models.push({
    id: "hf-whisper:" + real.toLowerCase(),
    identity: "hf-whisper:" + real.toLowerCase(),
    name: path.basename(real),
    displayName: path.basename(real),
    path: real,
    kind: "directory",
    format: "huggingface-whisper",
    confidence: "directory-signature",
    trusted: null,
    requiresTrust: false,
    sizeBytes: modelStat.size,
    origin: options.origin || "scan",
    compatible: false,
    status: "discovered",
    warnings: []
  });
}

function dedupeModels(models) {
  var seenIds = {};
  var seenIdentity = {};
  return (models || []).filter(function (model) {
    var identity = model.identity || model.id;
    if (seenIds[model.id] || seenIdentity[identity]) return false;
    seenIds[model.id] = true;
    seenIdentity[identity] = true;
    return true;
  });
}

function makeOutput(mode) {
  return { mode: mode, status: "scanning", models: [], warnings: [], warningKeys: {}, entries: 0, complete: true };
}

function markStopped(output, code, details) {
  output.complete = false;
  output.status = code === "E_SCAN_CANCELED" ? "canceled" : "partial";
  addWarning(output, { code: code, limit: details });
}

function walkRoots(roots, options, output, callback) {
  var queue = [];
  var visited = {};
  var finished = false;
  var startedAt = Date.now();
  roots.forEach(function (root) { if (root) queue.push({ path: path.resolve(root), depth: 0, root: true }); });

  function finish(error) {
    if (finished) return;
    finished = true;
    output.models = dedupeModels(output.models);
    delete output.warningKeys;
    if (output.status === "scanning") output.status = output.complete ? "completed" : "partial";
    callback(error, output);
  }

  function shouldStop() {
    if (options.shouldCancel && options.shouldCancel()) {
      markStopped(output, "E_SCAN_CANCELED");
      return true;
    }
    if (output.entries >= options.maxEntries) {
      markStopped(output, "W_SCAN_LIMIT_REACHED", { maxEntries: options.maxEntries });
      return true;
    }
    if (options.maxDurationMs > 0 && Date.now() - startedAt >= options.maxDurationMs) {
      markStopped(output, "W_SCAN_LIMIT_REACHED", { maxDurationMs: options.maxDurationMs });
      return true;
    }
    return false;
  }

  function step() {
    if (shouldStop()) return finish(null);
    if (!queue.length) return finish(null);
    var item = queue.shift();
    if (item.depth > options.maxDepth) return nextTurn(step);
    fs.lstat(item.path, function (statError, stat) {
      if (statError) {
        if (options.reportMissingRoots && item.root && statError.code === "ENOENT") addWarning(output, { code: "E_SCAN_PATH_NOT_FOUND", path: item.path });
        else if (statError.code !== "ENOENT") addWarning(output, { code: "W_SCAN_ACCESS_DENIED", path: item.path, reason: statError.code || "E_IO_DENIED" });
        return nextTurn(step);
      }
      output.entries += 1;
      if (options.onProgress) {
        try { options.onProgress({ currentPath: item.path, entries: output.entries, models: output.models.length }); } catch (ignore) {}
      }
      if (stat.isSymbolicLink && stat.isSymbolicLink()) return nextTurn(step);
      if (stat.isFile && stat.isFile()) {
        if (MODEL_EXTENSIONS[path.extname(item.path).toLowerCase()] && stat.size > 0) {
          var signature = fileSignature(item.path);
          if (signature.format !== "unknown") output.models.push(makeFileModel(item.path, stat, signature, options.origin));
        }
        return nextTurn(step);
      }
      if (!stat.isDirectory || !stat.isDirectory()) return nextTurn(step);
      fs.realpath(item.path, function (realError, resolved) {
        var real = realError ? path.resolve(item.path) : resolved;
        var key = real.toLowerCase();
        if (visited[key]) return nextTurn(step);
        visited[key] = true;
        fs.readdir(real, function (readError, names) {
          if (readError) {
            addWarning(output, { code: "W_SCAN_ACCESS_DENIED", path: real, reason: readError.code || "E_IO_DENIED" });
            return nextTurn(step);
          }
          inspectCTranslate2(real, names, options, output);
          inspectHuggingFaceWhisper(real, names, options, output);
          if (item.depth < options.maxDepth) {
            names.forEach(function (name) {
              if (!isIgnored(name)) queue.push({ path: path.join(real, name), depth: item.depth + 1, root: false });
            });
          }
          nextTurn(step);
        });
      });
    });
  }

  nextTurn(step);
}

function normalizedOptions(options, mode) {
  return {
    maxDepth: options.maxDepth === undefined ? (mode === "fullDisk" ? 12 : (mode === "deep" ? 8 : 5)) : options.maxDepth,
    maxEntries: options.maxEntries || (mode === "fullDisk" ? 300000 : (mode === "deep" ? 100000 : 20000)),
    maxDurationMs: options.maxDurationMs === undefined ? (mode === "deep" || mode === "fullDisk" ? 0 : 5000) : options.maxDurationMs,
    maxConfigBytes: options.maxConfigBytes || 1024 * 1024,
    shouldCancel: options.shouldCancel,
    onProgress: options.onProgress,
    origin: options.origin || (mode === "specified" ? "specified" : "scan"),
    reportMissingRoots: !!options.reportMissingRoots
  };
}

function inspectSpecified(target, options, callback) {
  options = options || {};
  if (!target) return callback(errors.makeError(errors.ERROR_CODES.SCAN_PATH_INVALID, "指定路径不能为空", { path: target }));
  fs.lstat(target, function (statError, stat) {
    if (statError) return callback(errors.makeError(errors.ERROR_CODES.SCAN_PATH_NOT_FOUND, "指定路径不存在", { path: target }));
    if (stat.isSymbolicLink && stat.isSymbolicLink()) return callback(errors.makeError(errors.ERROR_CODES.SCAN_PATH_INVALID, "指定路径不能是符号链接或联接", { path: target }));
    var scanOptions = normalizedOptions(options, "specified");
    scanOptions.reportMissingRoots = true;
    if (stat.isFile && stat.isFile()) scanOptions.maxDepth = 0;
    else scanOptions.maxDepth = options.recursive ? (options.maxDepth === undefined ? 8 : options.maxDepth) : 1;
    var output = makeOutput("specified");
    walkRoots([target], scanOptions, output, function (walkError, result) {
      if (walkError) return callback(walkError);
      if (!result.models.length && stat.isFile && stat.isFile()) {
        return callback(errors.makeError(errors.ERROR_CODES.MODEL_UNSUPPORTED, "无法识别模型格式", { path: target }));
      }
      callback(null, result);
    });
  });
}

function scanModels(options, callback) {
  options = options || {};
  var mode = options.mode || "quick";
  if (mode === "skip") {
    return nextTurn(function () { callback(null, { mode: "skip", status: "skipped", models: [], warnings: [], entries: 0, complete: true }); });
  }
  if (mode === "specified") {
    return inspectSpecified(options.specifiedPath || options.target || options.path, options, callback);
  }
  if (mode !== "quick" && mode !== "deep" && mode !== "fullDisk") {
    return nextTurn(function () { callback(errors.makeError(errors.ERROR_CODES.SCAN_PATH_INVALID, "未知扫描模式", { mode: mode })); });
  }
  var roots = options.roots || (mode === "fullDisk" ? windowsDriveRoots() : defaultRoots(options.extensionRoot));
  var output = makeOutput(mode);
  walkRoots(roots, normalizedOptions(options, mode), output, callback);
}

module.exports = {
  scanModels: scanModels,
  inspectSpecified: inspectSpecified,
  windowsDriveRoots: windowsDriveRoots,
  fileSignature: fileSignature,
  defaultRoots: defaultRoots,
  dedupeModels: dedupeModels,
  inspectHuggingFaceWhisper: inspectHuggingFaceWhisper
};
