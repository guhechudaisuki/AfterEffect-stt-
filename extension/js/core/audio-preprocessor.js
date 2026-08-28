"use strict";

var fs = require("fs");
var path = require("path");
var processController = require("./process-controller");
var errors = require("./errors");

function needsConversion(filePath) {
  var info = inspectWav(filePath);
  return !info.valid || info.audioFormat !== 1 || info.channels !== 1 || info.sampleRate !== 16000 || info.bitsPerSample !== 16 || !info.hasData;
}

function hasTrimRange(options) {
  var start = Number(options && options.startMs);
  var end = Number(options && options.endMs);
  return isFinite(start) && isFinite(end) && start >= 0 && end > start;
}

function playbackRate(options) {
  var rate = Number(options && options.playbackRate);
  return isFinite(rate) && rate > 0 ? rate : 1;
}

function atempoFilters(rate) {
  var filters = [];
  rate = Number(rate);
  if (!isFinite(rate) || rate <= 0) return filters;
  while (rate < 0.5) { filters.push("atempo=0.5"); rate /= 0.5; }
  while (rate > 2) { filters.push("atempo=2"); rate /= 2; }
  if (Math.abs(rate - 1) > 0.000001) filters.push("atempo=" + rate.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
  return filters;
}

function inspectWav(filePath) {
  var fd;
  try {
    var stat = fs.statSync(filePath);
    var length = Math.min(stat.size, 1024 * 1024);
    if (length < 44) return { valid: false };
    var buffer = Buffer.alloc ? Buffer.alloc(length) : new Buffer(length);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, length, 0);
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return { valid: false };
    var result = { valid: true, hasData: false };
    var offset = 12;
    while (offset + 8 <= buffer.length) {
      var id = buffer.toString("ascii", offset, offset + 4);
      var size = buffer.readUInt32LE(offset + 4);
      var dataOffset = offset + 8;
      if (id === "fmt " && size >= 16 && dataOffset + 16 <= buffer.length) {
        result.audioFormat = buffer.readUInt16LE(dataOffset);
        result.channels = buffer.readUInt16LE(dataOffset + 2);
        result.sampleRate = buffer.readUInt32LE(dataOffset + 4);
        result.bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
      } else if (id === "data") {
        result.hasData = size > 0;
        result.dataOffset = dataOffset;
        result.dataSize = size;
        break;
      }
      offset = dataOffset + size + (size % 2);
      if (offset > buffer.length) break;
    }
    return result;
  } catch (ignore) {
    return { valid: false };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (ignore) {} }
  }
}

function hasAudioSignal(filePath, options) {
  options = options || {};
  var info = inspectWav(filePath);
  if (!info.valid || !info.hasData) return false;
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) return true;
  var threshold = Number(options.threshold);
  if (!isFinite(threshold) || threshold < 0) threshold = 8;
  var windows = Number(options.windows);
  if (!isFinite(windows) || windows < 1) windows = 64;
  var windowBytes = Number(options.windowBytes);
  if (!isFinite(windowBytes) || windowBytes < 2) windowBytes = 4096;
  windowBytes -= windowBytes % 2;
  var fd;
  try {
    fd = fs.openSync(filePath, "r");
    var dataSize = Number(info.dataSize) || 0;
    var dataOffset = Number(info.dataOffset) || 44;
    var buffer = Buffer.alloc ? Buffer.alloc(windowBytes) : new Buffer(windowBytes);
    var count = Math.max(1, Math.min(windows, Math.ceil(dataSize / windowBytes)));
    for (var i = 0; i < count; i += 1) {
      var offset = dataSize <= windowBytes ? 0 : Math.floor(i * (dataSize - windowBytes) / (count - 1));
      offset -= offset % 2;
      var read = fs.readSync(fd, buffer, 0, windowBytes, dataOffset + offset);
      for (var j = 0; j + 1 < read; j += 2) {
        if (Math.abs(buffer.readInt16LE(j)) >= threshold) return true;
      }
    }
    return false;
  } catch (ignore) {
    return true;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (ignore) {} }
  }
}

function detectSpeechRegions(filePath, options) {
  options = options || {};
  var info = inspectWav(filePath);
  if (!info.valid || !info.hasData || info.audioFormat !== 1 || info.channels !== 1 || info.bitsPerSample !== 16) return [];
  var sampleRate = Number(info.sampleRate) || 16000;
  var windowMs = Number(options.windowMs);
  if (!isFinite(windowMs) || windowMs < 10) windowMs = 20;
  var windowBytes = Math.max(2, Math.round(sampleRate * windowMs / 1000) * 2);
  var count = Math.max(1, Math.ceil(Number(info.dataSize) / windowBytes));
  var levels = [];
  var peaks = [];
  var fd;
  try {
    fd = fs.openSync(filePath, "r");
    for (var index = 0; index < count; index += 1) {
      var buffer = Buffer.alloc ? Buffer.alloc(windowBytes) : new Buffer(windowBytes);
      var read = fs.readSync(fd, buffer, 0, windowBytes, Number(info.dataOffset) + index * windowBytes);
      var sum = 0;
      var peak = 0;
      var samples = 0;
      for (var offset = 0; offset + 1 < read; offset += 2) {
        var sample = buffer.readInt16LE(offset) / 32768;
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
        samples += 1;
      }
      var rms = samples ? Math.sqrt(sum / samples) : 0;
      levels.push(20 * Math.log10(Math.max(rms, 1e-7)));
      peaks.push(peak);
    }
  } catch (error) {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (ignore) {} }
  }
  if (!levels.length) return [];
  var sorted = levels.slice().sort(function (a, b) { return a - b; });
  var floor = sorted[Math.floor((sorted.length - 1) * 0.2)];
  var margin = Number(options.marginDb);
  if (!isFinite(margin) || margin < 3) margin = 8;
  var threshold = Math.max(Number(options.minDb) || -48, floor + margin);
  var active = levels.map(function (level, index) {
    return level >= threshold && peaks[index] >= (Number(options.minPeak) || 0.003);
  });
  var bridgeWindows = Math.max(0, Math.round((Number(options.bridgeMs) || 120) / windowMs));
  for (var i = 0; i < active.length;) {
    if (active[i]) { i += 1; continue; }
    var gapStart = i;
    while (i < active.length && !active[i]) i += 1;
    var gapEnd = i;
    if (gapStart > 0 && gapEnd < active.length && gapEnd - gapStart <= bridgeWindows) {
      for (var bridge = gapStart; bridge < gapEnd; bridge += 1) active[bridge] = true;
    }
  }
  var minimumWindows = Math.max(1, Math.round((Number(options.minSpeechMs) || 80) / windowMs));
  var regions = [];
  for (i = 0; i < active.length;) {
    if (!active[i]) { i += 1; continue; }
    var start = i;
    while (i < active.length && active[i]) i += 1;
    if (i - start >= minimumWindows) regions.push({ startMs: start * windowMs, endMs: Math.min(Number(info.dataSize) / (sampleRate * 2) * 1000, i * windowMs) });
  }
  return regions;
}

function partialWavPath(outputPath) {
  return /\.wav$/i.test(outputPath) ? outputPath.replace(/\.wav$/i, ".partial.wav") : outputPath + ".partial.wav";
}

function reversePcm16Buffer(buffer) {
  for (var left = 0, right = buffer.length - 2; left < right; left += 2, right -= 2) {
    var first = buffer.readInt16LE(left);
    buffer.writeInt16LE(buffer.readInt16LE(right), left);
    buffer.writeInt16LE(first, right);
  }
  return buffer;
}

function reversePcm16File(filePath) {
  var info = inspectWav(filePath);
  if (!info.valid || info.audioFormat !== 1 || info.channels !== 1 || info.bitsPerSample !== 16 || !info.hasData) throw new Error("reverse requires mono PCM16 WAV");
  var fd = fs.openSync(filePath, "r+");
  var leftSample = 0;
  var rightSample = Math.floor(info.dataSize / 2);
  var maxSamples = 32768;
  try {
    while (rightSample - leftSample > 1) {
      var count = Math.min(maxSamples, Math.floor((rightSample - leftSample) / 2));
      if (!count) break;
      var leftBytes = Buffer.alloc ? Buffer.alloc(count * 2) : new Buffer(count * 2);
      var rightBytes = Buffer.alloc ? Buffer.alloc(count * 2) : new Buffer(count * 2);
      var rightStart = rightSample - count;
      fs.readSync(fd, leftBytes, 0, leftBytes.length, info.dataOffset + leftSample * 2);
      fs.readSync(fd, rightBytes, 0, rightBytes.length, info.dataOffset + rightStart * 2);
      reversePcm16Buffer(leftBytes);
      reversePcm16Buffer(rightBytes);
      fs.writeSync(fd, rightBytes, 0, rightBytes.length, info.dataOffset + leftSample * 2);
      fs.writeSync(fd, leftBytes, 0, leftBytes.length, info.dataOffset + rightStart * 2);
      leftSample += count;
      rightSample -= count;
    }
  } finally { fs.closeSync(fd); }
}

function prepareAudio(inputPath, outputPath, ffmpegPath, options, callback) {
  options = options || {};
  if (!fs.existsSync(inputPath)) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.AUDIO_INPUT_NOT_FOUND, "音频文件不存在", { path: inputPath })); });
  var trimRange = hasTrimRange(options);
  var rate = playbackRate(options);
  var reverse = options.reverse === true;
  var expectedDurationMs = Number(options.expectedDurationMs);
  var hasExpectedDuration = isFinite(expectedDurationMs) && expectedDurationMs > 0;
  var conversionRequired = needsConversion(inputPath) || trimRange || reverse || Math.abs(rate - 1) > 0.000001 || hasExpectedDuration;
  if (!ffmpegPath && conversionRequired) return process.nextTick(function () { callback(errors.makeError(errors.ERROR_CODES.FFMPEG_NOT_FOUND, "输入 WAV 不是 16 kHz 单声道 PCM16，需要 FFmpeg 转换")); });
  var partial = partialWavPath(outputPath);
  var directCancelled = false;
  try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (ignore) {}
  try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (ignoreOutput) {}
  if (!conversionRequired) {
    process.nextTick(function () {
      if (directCancelled || options.cancelled && options.cancelled()) return callback(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
      try {
        fs.copyFileSync(inputPath, partial);
        if (!inspectWav(partial).valid) throw new Error("invalid wav");
        fs.renameSync(partial, outputPath);
      } catch (error) {
        try { fs.unlinkSync(partial); } catch (ignore) {}
        return callback(errors.makeError(errors.ERROR_CODES.AUDIO_CONVERT_FAILED, "无法复制 WAV", { reason: error.message }));
      }
      callback(null, outputPath);
    });
    return { cancel: function () { directCancelled = true; } };
  }
  var args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  if (trimRange) {
    args.push("-ss", (Number(options.startMs) / 1000).toFixed(3));
    args.push("-t", ((Number(options.endMs) - Number(options.startMs)) / 1000).toFixed(3));
  }
  args.push("-i", inputPath);
  var filters = [];
  filters = filters.concat(atempoFilters(rate));
  if (hasExpectedDuration) filters.push("apad", "atrim=duration=" + (expectedDurationMs / 1000).toFixed(6), "asetpts=N/SR/TB");
  if (filters.length) args.push("-af", filters.join(","));
  args.push("-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", partial);
  return processController.spawnProcess(ffmpegPath, args, { cwd: path.dirname(partial), timeoutMs: options.timeoutMs || 15 * 60 * 1000, cancelled: options.cancelled, onStderr: options.onStderr }, function (error) {
    if (error) {
      try { fs.unlinkSync(partial); } catch (ignore) {}
      return callback(error.code === errors.ERROR_CODES.JOB_CANCELED ? error : errors.makeError(errors.ERROR_CODES.AUDIO_CONVERT_FAILED, "FFmpeg 音频转换失败", { reason: error.message }));
    }
    try {
      var info = inspectWav(partial);
      if (!info.valid || !info.hasData || info.audioFormat !== 1 || info.channels !== 1 || info.sampleRate !== 16000 || info.bitsPerSample !== 16) throw new Error("invalid output wav");
      if (reverse) reversePcm16File(partial);
      fs.renameSync(partial, outputPath);
    } catch (renameError) {
      try { fs.unlinkSync(partial); } catch (ignore) {}
      return callback(errors.makeError(errors.ERROR_CODES.AUDIO_CONVERT_FAILED, "输出 WAV 无效", { reason: renameError.message }));
    }
    callback(null, outputPath);
  });
}

module.exports = { prepareAudio: prepareAudio, needsConversion: needsConversion, inspectWav: inspectWav, hasAudioSignal: hasAudioSignal, detectSpeechRegions: detectSpeechRegions, partialWavPath: partialWavPath, atempoFilters: atempoFilters, reversePcm16Buffer: reversePcm16Buffer, reversePcm16File: reversePcm16File };
