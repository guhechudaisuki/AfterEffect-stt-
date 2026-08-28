"use strict";

var fs = require("fs");
var path = require("path");
var processController = require("./process-controller");
var errors = require("./errors");

function detect(audioPath, descriptor, store, options, callback) {
  options = options || {};
  if (!descriptor || !descriptor.modelPath || !descriptor.pythonExecutable || !descriptor.bridgePath) return process.nextTick(function () { callback(null, []); });
  if (!fs.existsSync(descriptor.modelPath) || !fs.existsSync(descriptor.pythonExecutable) || !fs.existsSync(descriptor.bridgePath)) return process.nextTick(function () { callback(null, []); });
  var requestPath = store.path("vad-request.json");
  var outputPath = store.path("vad-result.json");
  try {
    fs.writeFileSync(requestPath, JSON.stringify({ modelPath: descriptor.modelPath, audioPath: audioPath, outputPath: outputPath, device: options.device === "cuda" ? "cuda" : "cpu" }), "utf8");
  } catch (writeError) { return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.TEMP_PERMISSION, "无法写入 VAD 请求", { reason: writeError.message })); }); }
  var stdout = "";
  return processController.spawnProcess(descriptor.pythonExecutable, ["-E", "-s", descriptor.bridgePath, requestPath], {
    cwd: store.directory,
    timeoutMs: options.timeoutMs || 30 * 60 * 1000,
    cancelled: options.cancelled,
    onStdout: function (chunk) {
      stdout += chunk;
      var lines = stdout.split(/\r?\n/); stdout = lines.pop();
      lines.forEach(function (line) { if (line.indexOf("LWS_EVENT ") === 0 && options.onEvent) try { options.onEvent(JSON.parse(line.slice(10))); } catch (ignore) {} });
    }
  }, function (error) {
    if (error) return callback(error);
    if (!fs.existsSync(outputPath)) return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "VAD 没有生成结果"));
    try {
      var result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      if (result.error) return callback(errors.makeError(errors.ERROR_CODES.PROCESS_EXIT, "FunASR VAD 失败", { reason: result.error }));
      callback(null, Array.isArray(result.regions) ? result.regions : []);
    } catch (parseError) { callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "VAD 结果无效", { reason: parseError.message })); }
  });
}

module.exports = { detect: detect };
