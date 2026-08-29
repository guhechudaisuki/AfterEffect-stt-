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

function finiteNumber(value) {
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function optionFromContainers(containers, names) {
  for (var i = 0; i < containers.length; i += 1) {
    var container = containers[i];
    if (!container || typeof container !== "object") continue;
    for (var j = 0; j < names.length; j += 1) {
      var name = names[j];
      if (Object.prototype.hasOwnProperty.call(container, name) && container[name] !== undefined && container[name] !== null) return container[name];
    }
  }
  return undefined;
}

function decodingContainers(request) {
  request = request || {};
  var containers = [];
  ["decoding", "decode", "decodeOptions", "whispercpp", "whisperCpp", "whisperCppOptions"].forEach(function (name) {
    if (request[name] && typeof request[name] === "object") containers.push(request[name]);
  });
  containers.push(request);
  return containers;
}

function vadContainers(request) {
  request = request || {};
  var containers = [];
  ["vadOptions", "vadParams", "vadParameters"].forEach(function (name) {
    if (request[name] && typeof request[name] === "object") containers.push(request[name]);
  });
  decodingContainers(request).forEach(function (container) {
    ["vadOptions", "vadParams", "vadParameters", "vad"].forEach(function (name) {
      if (container[name] && typeof container[name] === "object") containers.push(container[name]);
    });
  });
  containers.push(request);
  return containers;
}

function optionValue(request, names) {
  return optionFromContainers(decodingContainers(request), names);
}

function vadOptionValue(request, names) {
  return optionFromContainers(vadContainers(request), names);
}

function booleanValue(value) {
  return value === true || value === 1 || value === "1" || (typeof value === "string" && value.toLowerCase() === "true");
}

function appendNumber(args, flag, value, validator) {
  if (!flag || value === undefined || value === null || value === "") return false;
  var number = finiteNumber(value);
  if (number === null || (validator && !validator(number))) return false;
  args.push(flag, typeof value === "number" ? String(number) : String(value).trim());
  return true;
}

function appendBoolean(args, flag, value) {
  if (!flag || !booleanValue(value)) return false;
  args.push(flag);
  return true;
}

function appendPrompt(args, flag, value) {
  if (!flag || value === undefined || value === null) return false;
  var prompt = String(value).replace(/[\u0000\r\n]+/g, " ").trim();
  if (!prompt) return false;
  // whisper.cpp limits the initial prompt to half of the model text context.
  // We cannot know that context from the CLI probe, so keep a conservative
  // bound to avoid giant command lines while retaining normal terminology
  // lists and speaker names.
  if (prompt.length > 4096) prompt = prompt.slice(0, 4096);
  args.push(flag, prompt);
  return true;
}

function combinedPrompt(request) {
  var prompt = optionValue(request, ["initialPrompt", "initial_prompt", "prompt"]);
  var hotwords = optionValue(request, ["hotwords", "hotWords", "hot_words"]);
  var parts = [];
  [prompt, hotwords].forEach(function (value) {
    if (Array.isArray(value)) value = value.join(", ");
    if (value !== undefined && value !== null && String(value).trim()) parts.push(String(value).trim());
  });
  return parts.length ? parts.join("; ") : undefined;
}

function normalizeWord(token, index) {
  token = token || {};
  var offsets = token.offsets || {};
  var timestamps = token.timestamps || {};
  var probability = token.p !== undefined ? token.p : token.probability;
  var numericProbability = finiteNumber(probability);
  var startMs = Number(offsets.from !== undefined ? offsets.from : timestampToMs(timestamps.from));
  var endMs = Number(offsets.to !== undefined ? offsets.to : timestampToMs(timestamps.to));
  var word = {
    id: "w-" + index,
    text: token.text || token.token || "",
    startMs: isFinite(startMs) ? startMs : 0,
    endMs: isFinite(endMs) ? endMs : 0,
    probability: numericProbability === null ? probability : numericProbability
  };
  // Keep token-level diagnostics when a full JSON build provides them. These
  // fields are optional and do not alter the legacy shape for old runtimes.
  if (token.id !== undefined) word.tokenId = token.id;
  if (token.t_dtw !== undefined) word.tDtw = token.t_dtw;
  if (token.tDtw !== undefined) word.tDtw = token.tDtw;
  return word;
}

function copyQualityMetric(target, source, names, outputName) {
  var value = optionFromContainers([source], names);
  var number = finiteNumber(value);
  if (number !== null) target[outputName] = number;
}

function qualityForSegment(segment, words) {
  var probabilities = [];
  var timedWords = 0;
  (words || []).forEach(function (word) {
    var probability = finiteNumber(word.probability);
    if (probability !== null) probabilities.push(Math.max(0, Math.min(1, probability)));
    if (word.endMs > word.startMs) timedWords += 1;
  });
  var quality = {};
  if (words && words.length) {
    quality.tokenCount = words.length;
    quality.timedTokenCount = timedWords;
    quality.timedTokenRatio = timedWords / words.length;
  }
  if (probabilities.length) {
    var sum = probabilities.reduce(function (total, value) { return total + value; }, 0);
    quality.averageProbability = sum / probabilities.length;
    quality.minProbability = Math.min.apply(Math, probabilities);
    quality.maxProbability = Math.max.apply(Math, probabilities);
    // `confidence` is an alias for clients that display a single score.
    quality.confidence = quality.averageProbability;
    quality.lowConfidenceCount = probabilities.filter(function (value) { return value < 0.5; }).length;
    // Match the normalized quality keys used by the Python adapters so the
    // host can compare backends without engine-specific branches.
    quality.meanWordProbability = quality.averageProbability;
    quality.minWordProbability = quality.minProbability;
    quality.maxWordProbability = quality.maxProbability;
    quality.wordCount = probabilities.length;
  }
  copyQualityMetric(quality, segment, ["avg_logprob", "avgLogprob"], "averageLogProbability");
  copyQualityMetric(quality, segment, ["no_speech_prob", "noSpeechProb"], "noSpeechProbability");
  copyQualityMetric(quality, segment, ["compression_ratio", "compressionRatio"], "compressionRatio");
  copyQualityMetric(quality, segment, ["temperature"], "temperature");
  copyQualityMetric(quality, segment, ["entropy"], "entropy");
  if (quality.averageLogProbability !== undefined) quality.avgLogprob = quality.averageLogProbability;
  if (quality.noSpeechProbability !== undefined) quality.noSpeechProb = quality.noSpeechProbability;
  if (segment.quality && typeof segment.quality === "object") {
    ["averageProbability", "minProbability", "maxProbability", "confidence", "meanWordProbability", "minWordProbability", "maxWordProbability", "wordCount", "averageLogProbability", "avgLogprob", "noSpeechProbability", "noSpeechProb", "compressionRatio", "temperature", "entropy"].forEach(function (name) {
      var number = finiteNumber(segment.quality[name]);
      if (number !== null) quality[name] = number;
    });
  }
  if (quality.averageLogProbability === undefined && quality.avgLogprob !== undefined) quality.averageLogProbability = quality.avgLogprob;
  if (quality.avgLogprob === undefined && quality.averageLogProbability !== undefined) quality.avgLogprob = quality.averageLogProbability;
  if (quality.noSpeechProbability === undefined && quality.noSpeechProb !== undefined) quality.noSpeechProbability = quality.noSpeechProb;
  if (quality.noSpeechProb === undefined && quality.noSpeechProbability !== undefined) quality.noSpeechProb = quality.noSpeechProbability;
  return Object.keys(quality).length ? quality : null;
}

function summarizeQuality(segments) {
  var summary = { segmentCount: (segments || []).length, tokenCount: 0, timedTokenCount: 0, timedTokenRatio: null, averageProbability: null, minProbability: null, maxProbability: null, confidence: null, lowConfidenceCount: 0 };
  var probabilitySum = 0;
  var probabilityCount = 0;
  (segments || []).forEach(function (segment) {
    var quality = segment.quality || {};
    summary.tokenCount += Number(quality.tokenCount !== undefined ? quality.tokenCount : (quality.wordCount || 0));
    summary.timedTokenCount += Number(quality.timedTokenCount || 0);
    var segmentProbabilityCount = 0;
    (segment.words || []).forEach(function (word) {
      var probability = finiteNumber(word.probability);
      if (probability === null) return;
      probability = Math.max(0, Math.min(1, probability));
      probabilitySum += probability;
      probabilityCount += 1;
      segmentProbabilityCount += 1;
      if (probability < 0.5) summary.lowConfidenceCount += 1;
    });
    // Some wrapper builds expose only a segment mean. Weight that mean by the
    // reported word/token count rather than dropping useful quality metadata.
    if (!segmentProbabilityCount) {
      var mean = finiteNumber(quality.meanWordProbability !== undefined ? quality.meanWordProbability : quality.averageProbability);
      var weight = finiteNumber(quality.wordCount !== undefined ? quality.wordCount : quality.tokenCount);
      if (mean !== null) {
        weight = weight !== null && weight > 0 ? weight : 1;
        probabilitySum += mean * weight;
        probabilityCount += weight;
        summary.lowConfidenceCount += Number(quality.lowConfidenceCount || (mean < 0.5 ? weight : 0));
      }
    }
    var minimum = finiteNumber(quality.minWordProbability !== undefined ? quality.minWordProbability : quality.minProbability);
    var maximum = finiteNumber(quality.maxWordProbability !== undefined ? quality.maxWordProbability : quality.maxProbability);
    if (minimum !== null) summary.minProbability = summary.minProbability === null ? minimum : Math.min(summary.minProbability, minimum);
    if (maximum !== null) summary.maxProbability = summary.maxProbability === null ? maximum : Math.max(summary.maxProbability, maximum);
  });
  if (summary.tokenCount) summary.timedTokenRatio = summary.timedTokenCount / summary.tokenCount;
  if (probabilityCount) {
    summary.averageProbability = probabilitySum / probabilityCount;
    summary.confidence = summary.averageProbability;
  }
  return summary;
}

function parseWhisperJson(value) {
  var raw = typeof value === "string" ? JSON.parse(value) : value;
  if (!raw || typeof raw !== "object") throw new Error("Whisper JSON root must be an object");
  var list = raw.segments || raw.transcription || [];
  if (!Array.isArray(list)) throw new Error("Whisper JSON segments must be an array");
  return list.map(function (segment, index) {
    segment = segment || {};
    var offsets = segment.offsets || {};
    var timestamps = segment.timestamps || {};
    var startMs = segment.startMs !== undefined ? segment.startMs : (segment.start !== undefined ? segment.start * 1000 : (offsets.from !== undefined ? offsets.from : timestampToMs(timestamps.from)));
    var endMs = segment.endMs !== undefined ? segment.endMs : (segment.end !== undefined ? segment.end * 1000 : (offsets.to !== undefined ? offsets.to : timestampToMs(timestamps.to)));
    var tokens = segment.words || segment.tokens || [];
    if (!Array.isArray(tokens)) tokens = [];
    var words = tokens.map(normalizeWord).filter(function (word) { return word.text && word.endMs >= word.startMs; });
    var normalizedStart = finiteNumber(startMs);
    var normalizedEnd = finiteNumber(endMs);
    normalizedStart = normalizedStart === null ? 0 : Math.round(normalizedStart);
    normalizedEnd = normalizedEnd === null ? normalizedStart : Math.round(normalizedEnd);
    var normalized = { id: segment.id || "raw-" + index, startMs: normalizedStart, endMs: normalizedEnd, text: segment.text || "", words: words };
    var quality = qualityForSegment(segment, words);
    if (quality) normalized.quality = quality;
    if (segment.speaker !== undefined) normalized.speaker = segment.speaker;
    if (segment.speaker_turn_next !== undefined) normalized.speakerTurnNext = !!segment.speaker_turn_next;
    return normalized;
  });
}

function buildArgs(runtime, request, outputPrefix) {
  request = request || {};
  runtime = runtime || {};
  var args = ["-m", request.modelPath, "-f", request.audioPath, "-l", request.language && request.language !== "auto" ? request.language : "auto", "-t", String(request.threads || 4)];
  var flags = runtime.flags || {};
  if (!flags.jsonFull) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 未探测到完整 JSON 输出参数");
  args.push(flags.jsonFull, "-of", outputPrefix);
  if (request.device === "cpu") {
    if (!flags.noGpu) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 未探测到 CPU 回退参数");
    args.push(flags.noGpu);
  }
  if (request.device === "vulkan") {
    if (runtime.devices && runtime.devices.indexOf("vulkan") < 0) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "当前 whisper.cpp 运行时不支持 Vulkan");
    if (!flags.device) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp 未探测到 Vulkan 设备参数");
    args.push(flags.device, String(request.deviceIndex === undefined ? 0 : request.deviceIndex));
  }

  // Keep legacy defaults when no decoding options are supplied. Values are
  // emitted only when the runtime probe confirmed each flag.
  var beamSize = optionValue(request, ["beamSize", "beam_size", "beam"]);
  if (beamSize === undefined) beamSize = "5";
  if (flags.beamSize) appendNumber(args, flags.beamSize, beamSize, function (value) { return value >= 1 && value <= 256; });
  var splitOnWord = optionValue(request, ["splitOnWord", "split_on_word"]);
  if (flags.splitOnWord && (splitOnWord === undefined || booleanValue(splitOnWord))) args.push(flags.splitOnWord);
  var noSpeechThreshold = optionValue(request, ["noSpeechThreshold", "no_speech_threshold", "noSpeechThold", "no_speech_thold"]);
  if (noSpeechThreshold === undefined) noSpeechThreshold = "0.60";
  if (flags.noSpeechThreshold) appendNumber(args, flags.noSpeechThreshold, noSpeechThreshold, function (value) { return value >= 0 && value <= 1; });
  var logprobThreshold = optionValue(request, ["logprobThreshold", "logprob_threshold", "logprobThold", "logprob_thold"]);
  if (logprobThreshold === undefined) logprobThreshold = "-1.00";
  if (flags.logprobThreshold) appendNumber(args, flags.logprobThreshold, logprobThreshold);
  var temperature = optionValue(request, ["temperature"]);
  if (temperature === undefined) temperature = "0.00";
  if (flags.temperature) appendNumber(args, flags.temperature, temperature, function (value) { return value >= 0 && value <= 1; });

  // Optional decoder controls. Invalid values are ignored rather than passed
  // to the CLI, keeping persisted settings safe across runtime versions.
  appendNumber(args, flags.maxContext, optionValue(request, ["maxContext", "max_context"]), function (value) { return value >= -1 && value <= 32768; });
  appendNumber(args, flags.maxLen, optionValue(request, ["maxLen", "max_len"]), function (value) { return value >= 0 && value <= 65536; });
  appendNumber(args, flags.bestOf, optionValue(request, ["bestOf", "best_of"]), function (value) { return value >= 1 && value <= 256; });
  appendNumber(args, flags.audioCtx, optionValue(request, ["audioCtx", "audio_ctx"]), function (value) { return value >= 0 && value <= 1500; });
  appendNumber(args, flags.wordThold, optionValue(request, ["wordThold", "word_thold", "wordThreshold", "word_threshold"]), function (value) { return value >= 0 && value <= 1; });
  appendNumber(args, flags.entropyThold, optionValue(request, ["entropyThold", "entropy_thold", "entropyThreshold", "entropy_threshold"]), function (value) { return value >= 0 && value <= 100; });
  var noFallback = optionValue(request, ["noFallback", "no_fallback"]);
  var temperatureFallback = optionValue(request, ["temperatureFallback", "temperature_fallback"]);
  if (noFallback === undefined && temperatureFallback !== undefined) noFallback = !booleanValue(temperatureFallback);
  var temperatureInc = optionValue(request, ["temperatureInc", "temperature_inc"]);
  if (!booleanValue(noFallback) && temperatureInc === undefined && booleanValue(temperatureFallback)) temperatureInc = "0.20";
  if (!booleanValue(noFallback)) appendNumber(args, flags.temperatureInc, temperatureInc, function (value) { return value >= 0 && value <= 1; });
  appendBoolean(args, flags.noFallback, noFallback);

  appendPrompt(args, flags.prompt, combinedPrompt(request));
  appendBoolean(args, flags.carryInitialPrompt, optionValue(request, ["carryInitialPrompt", "carry_initial_prompt"]));
  appendBoolean(args, flags.suppressNst, optionValue(request, ["suppressNst", "suppress_nst", "suppressNonSpeechTokens", "suppress_non_speech_tokens"]));
  var suppressRegex = optionValue(request, ["suppressRegex", "suppress_regex"]);
  if (flags.suppressRegex && suppressRegex !== undefined && suppressRegex !== null) {
    var regexText = String(suppressRegex).replace(/[\u0000\r\n]+/g, " ").trim();
    if (regexText && regexText.length <= 4096) args.push(flags.suppressRegex, regexText);
  }
  var flashAttention = optionValue(request, ["flashAttention", "flash_attention", "flashAttn", "flash_attn", "useFlashAttention"]);
  if (flashAttention !== undefined) {
    if (booleanValue(flashAttention)) appendBoolean(args, flags.flashAttn, true);
    else appendBoolean(args, flags.noFlashAttn, true);
  }
  appendBoolean(args, flags.printConfidence, optionValue(request, ["printConfidence", "print_confidence"]));
  appendBoolean(args, flags.logScore, optionValue(request, ["logScore", "log_score"]));

  if (request.vad) {
    var vadModelPath = request.vadModelPath || vadOptionValue(request, ["modelPath", "vadModelPath", "vad_model_path"]);
    if (!flags.vad || !flags.vadModel || !vadModelPath) throw errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "whisper.cpp VAD 参数或模型不可用");
    args.push(flags.vad, flags.vadModel, String(vadModelPath));
    appendNumber(args, flags.vadThreshold, vadOptionValue(request, ["threshold", "vadThreshold", "vad_threshold"]), function (value) { return value >= 0 && value <= 1; });
    appendNumber(args, flags.vadMinSpeechDurationMs, vadOptionValue(request, ["minSpeechDurationMs", "min_speech_duration_ms", "vadMinSpeechDurationMs", "vad_min_speech_duration_ms"]), function (value) { return value >= 0 && value <= 3600000; });
    appendNumber(args, flags.vadMinSilenceDurationMs, vadOptionValue(request, ["minSilenceDurationMs", "min_silence_duration_ms", "vadMinSilenceDurationMs", "vad_min_silence_duration_ms"]), function (value) { return value >= 0 && value <= 3600000; });
    appendNumber(args, flags.vadMaxSpeechDurationS, vadOptionValue(request, ["maxSpeechDurationS", "max_speech_duration_s", "vadMaxSpeechDurationS", "vad_max_speech_duration_s"]), function (value) { return value >= 0 && value <= 86400; });
    appendNumber(args, flags.vadSpeechPadMs, vadOptionValue(request, ["speechPadMs", "speech_pad_ms", "vadSpeechPadMs", "vad_speech_pad_ms"]), function (value) { return value >= 0 && value <= 3600000; });
    appendNumber(args, flags.vadSamplesOverlap, vadOptionValue(request, ["samplesOverlap", "samples_overlap", "vadSamplesOverlap", "vad_samples_overlap"]), function (value) { return value >= 0 && value <= 1; });
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
  var requestedVadModelPath = request.vadModelPath || vadOptionValue(request, ["modelPath", "vadModelPath", "vad_model_path"]);
  if (request.vad && runtime.flags && runtime.flags.vadModel && !requestedVadModelPath) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "缺少 whisper.cpp VAD 模型")); });
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
    var rawOutput;
    try {
      var stat = fs.statSync(output);
      if (stat.size > (options.maxOutputBytes || 64 * 1024 * 1024)) throw new Error("Whisper JSON exceeds output limit");
      var jsonText = fs.readFileSync(output, "utf8").replace(/^\uFEFF/, "");
      rawOutput = JSON.parse(jsonText);
      parsed = parseWhisperJson(rawOutput);
      if (!Array.isArray(parsed)) throw new Error("segments must be an array");
    } catch (parseError) {
      return callback(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "Whisper JSON 无效", { reason: parseError.message }));
    }
    var detectedLanguage = rawOutput && rawOutput.result && rawOutput.result.language || rawOutput && rawOutput.language || null;
    var languageProbability = rawOutput && rawOutput.result && finiteNumber(rawOutput.result.language_probability !== undefined ? rawOutput.result.language_probability : rawOutput.result.languageProbability);
    var quality = summarizeQuality(parsed);
    callback(null, {
      segments: parsed,
      outputPath: output,
      language: detectedLanguage,
      languageProbability: languageProbability,
      quality: quality,
      engine: { name: "whisper.cpp", version: runtime.version || null, device: request.device, quality: quality }
    });
  });
}

module.exports = { run: run, buildArgs: buildArgs, parseWhisperJson: parseWhisperJson, summarizeQuality: summarizeQuality, timestampToMs: timestampToMs };
