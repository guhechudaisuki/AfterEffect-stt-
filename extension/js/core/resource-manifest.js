"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var errors = require("./errors");

function readManifest(filePath) {
  var text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch (error) {
    throw errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源清单无法读取", { path: filePath, reason: error.code || error.message });
  }
  var manifest;
  try { manifest = JSON.parse(text); } catch (error) {
    throw errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源清单 JSON 无效", { path: filePath });
  }
  if (!manifest || typeof manifest.schemaVersion !== "string" && typeof manifest.schemaVersion !== "number") {
    throw errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源清单缺少版本");
  }
  if (!Array.isArray(manifest.runtimes)) manifest.runtimes = [];
  if (!Array.isArray(manifest.models)) manifest.models = [];
  return manifest;
}

function sha256(filePath, callback) {
  var hash = crypto.createHash("sha256");
  var stream;
  try { stream = fs.createReadStream(filePath); } catch (error) { return callback(error); }
  stream.on("data", function (chunk) { hash.update(chunk); });
  stream.on("error", callback);
  stream.on("end", function () { callback(null, hash.digest("hex")); });
}

function verifyFile(filePath, expectedHash, expectedSize, callback) {
  fs.stat(filePath, function (statError, stat) {
    if (statError) return callback(errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源文件不存在", { path: filePath }));
    if (!stat.isFile()) return callback(errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源路径不是文件", { path: filePath }));
    if (expectedSize !== undefined && Number(expectedSize) !== stat.size) return callback(errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源长度不匹配", { path: filePath, expected: expectedSize, actual: stat.size }));
    sha256(filePath, function (hashError, actualHash) {
      if (hashError) return callback(errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源校验失败", { path: filePath }));
      if (expectedHash && actualHash.toLowerCase() !== String(expectedHash).toLowerCase()) return callback(errors.makeError(errors.ERROR_CODES.RESOURCE_INTEGRITY, "资源 SHA-256 不匹配", { path: filePath }));
      callback(null, { path: filePath, size: stat.size, sha256: actualHash });
    });
  });
}

function resolvePackage(manifest, root, id) {
  var all = (manifest.runtimes || []).concat(manifest.models || []);
  var item = all.filter(function (entry) { return entry.id === id; })[0];
  if (!item) return null;
  var relative = item.localPath || item.archive;
  if (!relative || typeof relative !== "string" || path.isAbsolute(relative)) return null;
  var rootResolved = path.resolve(root);
  var resolved = path.resolve(rootResolved, relative);
  var prefix = rootResolved.charAt(rootResolved.length - 1) === path.sep ? rootResolved : rootResolved + path.sep;
  if (resolved !== rootResolved && resolved.indexOf(prefix) !== 0) return null;
  return { item: item, path: resolved };
}

module.exports = { readManifest: readManifest, sha256: sha256, verifyFile: verifyFile, resolvePackage: resolvePackage };
