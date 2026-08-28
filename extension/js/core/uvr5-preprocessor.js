"use strict";

var fs = require("fs");
var path = require("path");
var processController = require("./process-controller");
var errors = require("./errors");

function separate(inputPath, outputPath, descriptor, options, callback) {
  options = options || {};
  if (!descriptor || !descriptor.path || !descriptor.uvrRoot || !descriptor.pythonExecutable) {
    return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.UVR5_NOT_CONFIGURED, "UVR5 模型或运行环境未配置")); });
  }
  var bridgePath = options.bridgePath;
  var requestPath = path.join(path.dirname(outputPath), "uvr5-request.json");
  var request = {
    inputPath: inputPath,
    outputPath: outputPath,
    modelPath: descriptor.path,
    uvrRoot: descriptor.uvrRoot,
    ffmpegPath: options.ffmpegPath,
    devicePolicy: options.devicePolicy || "auto",
    chunkSeconds: 60,
    overlapSeconds: 2
  };
  try { fs.writeFileSync(requestPath, JSON.stringify(request), "utf8"); }
  catch (writeError) { return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.TEMP_PERMISSION, "无法写入 UVR5 请求", { reason: writeError.message })); }); }
  var stdout = "";
  var environment = {};
  Object.keys(process.env).forEach(function (key) { environment[key] = process.env[key]; });
  environment.PYTHONUTF8 = "1";
  environment.PYTHONIOENCODING = "utf-8";
  return processController.spawnProcess(descriptor.pythonExecutable, ["-E", "-s", bridgePath, requestPath], {
    cwd: descriptor.uvrRoot,
    env: environment,
    timeoutMs: options.timeoutMs || 24 * 60 * 60 * 1000,
    cancelled: options.cancelled,
    onStdout: function (chunk) {
      stdout += chunk;
      var lines = stdout.split(/\r?\n/); stdout = lines.pop();
      lines.forEach(function (line) { if (line.indexOf("LWS_EVENT ") === 0 && options.onEvent) try { options.onEvent(JSON.parse(line.slice(10))); } catch (ignore) {} });
    }
  }, function (error) {
    if (error) return callback(errors.makeError(errors.ERROR_CODES.UVR5_FAILED, "UVR5 人声提取失败", { reason: error.message, details: error.details || {} }));
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 44) return callback(errors.makeError(errors.ERROR_CODES.UVR5_FAILED, "UVR5 没有生成有效人声音频"));
    callback(null, outputPath);
  });
}

module.exports = { separate: separate };
