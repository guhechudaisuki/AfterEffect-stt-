"use strict";

var fs = require("fs");
var path = require("path");
var processController = require("./process-controller");
var errors = require("./errors");

function run(runtime, request, options, callback) {
  options = options || {};
  if (!runtime || !runtime.executable || !runtime.bridgePath) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "Python Whisper bridge 不完整")); });
  var requestPath = path.join(request.cwd, "python-request.json");
  var outputPath = path.join(request.cwd, "python-result.json");
  var requestPartial = requestPath + ".partial";
  try {
    fs.writeFileSync(requestPartial, JSON.stringify({ engine: runtime.engine, modelPath: request.modelPath, audioPath: request.audioPath, language: request.language, device: request.device, deviceIndex: request.deviceIndex || 0, computeType: request.computeType, outputPath: outputPath, vad: request.vad !== false, vadModelPath: request.vadModelPath || null, allowHybrid: request.allowHybrid === true, modelSizeBytes: request.modelSizeBytes || null, speechRegions: Array.isArray(request.speechRegions) ? request.speechRegions : [], speechRegionPaddingMs: request.speechRegionPaddingMs === undefined ? 50 : request.speechRegionPaddingMs }), "utf8");
    fs.renameSync(requestPartial, requestPath);
  } catch (writeError) {
    try { fs.unlinkSync(requestPartial); } catch (ignore) {}
    return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.TEMP_PERMISSION, "无法写入 Python 请求", { reason: writeError.code || writeError.message })); });
  }
  var env = {};
  Object.keys(process.env).forEach(function (key) { if (key !== "PYTHONPATH" && key !== "PYTHONHOME") env[key] = process.env[key]; });
  var stdoutBuffer = "";
  return processController.spawnProcess(runtime.executable, ["-E", "-s", runtime.bridgePath, requestPath], { cwd: request.cwd, env: env, timeoutMs: options.timeoutMs || 24 * 60 * 60 * 1000, cancelled: options.cancelled, onStdout: function (chunk) {
    stdoutBuffer += chunk;
    var lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    lines.forEach(function (line) {
      if (line.indexOf("LWS_EVENT ") !== 0 || !options.onEvent) return;
      try { options.onEvent(JSON.parse(line.slice(10))); } catch (ignore) {}
    });
  } }, function (error) {
    if (error) {
      if (/CUDA.*out of memory|CUBLAS_STATUS_ALLOC_FAILED|out of memory/i.test(error.message + " " + JSON.stringify(error.details || {}))) error.details = { oom: true };
      return callback(error);
    }
    if (!fs.existsSync(outputPath)) return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "Python Whisper 没有生成结果"));
    var result;
    try {
      var stat = fs.statSync(outputPath);
      if (stat.size > (options.maxOutputBytes || 64 * 1024 * 1024)) throw new Error("Python Whisper JSON exceeds output limit");
      result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch (parseError) { return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "Python Whisper 结果无效", { reason: parseError.message })); }
    if (result.error) {
      var runtimeError = errors.makeError(errors.ERROR_CODES.PROCESS_EXIT, result.error.message || "Python Whisper 失败", result.error);
      if (result.error.oom) runtimeError.details.oom = true;
      return callback(runtimeError);
    }
    if (!Array.isArray(result.segments)) return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "Python Whisper 结果缺少 segments"));
    callback(null, result);
  });
}

module.exports = { run: run };
