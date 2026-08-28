"use strict";

var fs = require("fs");
var processController = require("./process-controller");
var errors = require("./errors");

function timestampToMs(value) {
  if (typeof value === "number") return value;
  var match = String(value || "").match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!match) return 0;
  var millis = String(match[4]);
  while (millis.length < 3) millis += "0";
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(millis.slice(0, 3));
}

function normalizeWord(token, index) {
  var offsets = token.offsets || {};
  var timestamps = token.timestamps || {};
  return {
    id: "w-" + index,
    text: token.text || token.token || "",
    startMs: Number(offsets.from !== undefined ? offsets.from : timestampToMs(timestamps.from)),
    endMs: Number(offsets.to !== undefined ? offsets.to : timestampToMs(timestamps.to)),
    probability: token.p !== undefined ? token.p : token.probability
  };
}

function parseWhisperJson(value) {
  var raw = typeof value === "string" ? JSON.parse(value) : value;
  var list = raw.segments || raw.transcription || [];
  return list.map(function (segment, index) {
    var offsets = segment.offsets || {};
    var timestamps = segment.timestamps || {};
    var startMs = segment.startMs !== undefined ? segment.startMs : (segment.start !== undefined ? segment.start * 1000 : (offsets.from !== undefined ? offsets.from : timestampToMs(timestamps.from)));
    var endMs = segment.endMs !== undefined ? segment.endMs : (segment.end !== undefined ? segment.end * 1000 : (offsets.to !== undefined ? offsets.to : timestampToMs(timestamps.to)));
    var tokens = segment.words || segment.tokens || [];
    var words = tokens.map(normalizeWord).filter(function (word) { return word.text && word.endMs >= word.startMs; });
    return { id: segment.id || "raw-" + index, startMs: Math.round(startMs || 0), endMs: Math.round(endMs || startMs || 0), text: segment.text || "", words: words };
  });
}

function buildArgs(runtime, request, outputPrefix) {
  var args = ["-m", request.modelPath, "-f", request.audioPath, "-l", request.language && request.language !== "auto" ? request.language : "auto", "-t", String(request.threads || 4)];
  var flags = runtime.flags || {};
  if (!flags.jsonFull) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 未探测到完整 JSON 输出参数");
  args.push(flags.jsonFull);
  args.push("-of", outputPrefix);
  if (request.device === "cpu") {
    if (!flags.noGpu) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 未探测到 CPU 回退参数");
    args.push(flags.noGpu);
  }
  if (request.device === "vulkan") {
    if (runtime.devices && runtime.devices.indexOf("vulkan") < 0) {
      throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "当前 whisper.cpp 运行时不支持 Vulkan");
    }
    if (!flags.device) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 未探测到 Vulkan 设备参数");
    args.push(flags.device, String(request.deviceIndex === undefined ? 0 : request.deviceIndex));
  }
  if (flags.beamSize) args.push(flags.beamSize, "5");
  if (flags.splitOnWord) args.push(flags.splitOnWord);
  if (flags.noSpeechThreshold) args.push(flags.noSpeechThreshold, "0.60");
  if (flags.logprobThreshold) args.push(flags.logprobThreshold, "-1.00");
  if (flags.temperature) args.push(flags.temperature, "0.00");
  if (request.vad) {
    if (!flags.vad || !flags.vadModel || !request.vadModelPath) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp VAD 参数或模型不可用");
    args.push(flags.vad, flags.vadModel, request.vadModelPath);
  }
  return args;
}

function findOutput(prefix) {
  var candidates = [prefix + ".json", prefix + ".json.json"];
  for (var i = 0; i < candidates.length; i += 1) if (fs.existsSync(candidates[i])) return candidates[i];
  return null;
}

function run(runtime, request, options, callback) {
  options = options || {};
  if (!runtime || !runtime.executable) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.RUNTIME_NOT_FOUND, "whisper.cpp 可执行文件不存在")); });
  if (runtime.capabilities && runtime.capabilities.wordTimestamps === false) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 不支持词级时间戳")); });
  if (request.vad && runtime.capabilities && runtime.capabilities.vad === false) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 不支持 VAD")); });
  if (request.vad && runtime.flags && runtime.flags.vadModel && !request.vadModelPath) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "缺少 whisper.cpp VAD 模型")); });
  var prefix = request.outputPrefix;
  var args;
  try { args = buildArgs(runtime, request, prefix); } catch (argumentError) {
    return process.nextTick(function () { callback(argumentError); });
  }
  var stderrBuffer = "";
  return processController.spawnProcess(runtime.executable, args, { cwd: request.cwd, timeoutMs: options.timeoutMs || 24 * 60 * 60 * 1000, cancelled: options.cancelled, onStderr: function (chunk) {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 10000) stderrBuffer = stderrBuffer.slice(-10000);
    var progress = String(chunk).match(/(\d{1,3})\s*%/);
    if (progress && options.onProgress) options.onProgress(Math.min(100, Number(progress[1])));
  } }, function (error) {
    if (error) {
      if (/out of memory|out of device memory|allocation failed|cuda.*alloc|cublas.*alloc|vulkan.*alloc|ggml.*alloc/i.test(stderrBuffer + " " + error.message)) error.details = { oom: true, stderr: stderrBuffer.slice(-1000) };
      return callback(error);
    }
    var output = findOutput(prefix);
    if (!output) return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "Whisper 没有生成 JSON 输出", { prefix: prefix }));
    var parsed;
    try {
      var stat = fs.statSync(output);
      if (stat.size > (options.maxOutputBytes || 64 * 1024 * 1024)) throw new Error("Whisper JSON exceeds output limit");
      parsed = parseWhisperJson(fs.readFileSync(output, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("segments must be an array");
    } catch (parseError) {
      return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "Whisper JSON 无效", { reason: parseError.message }));
    }
    callback(null, { segments: parsed, outputPath: output, engine: { name: "whisper.cpp", version: runtime.version || null, device: request.device } });
  });
}

module.exports = { run: run, buildArgs: buildArgs, parseWhisperJson: parseWhisperJson, timestampToMs: timestampToMs };
