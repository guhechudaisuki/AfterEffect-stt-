"use strict";

var fs = require("fs");
var path = require("path");
var processController = require("./process-controller");
var errors = require("./errors");

function targetAudioFormat(options) {
  options = options || {};
  var sampleRate = Number(options.targetSampleRate);
  if (!isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) sampleRate = 16000;
  var channels = Number(options.targetChannels);
  if (!isFinite(channels) || Math.floor(channels) !== channels || channels < 1 || channels > 2) channels = 1;
  return { sampleRate: sampleRate, channels: channels, bitsPerSample: 16 };
}

function needsConversionFor(filePath, options) {
  var info = inspectWav(filePath);
  var target = targetAudioFormat(options);
  return !info.valid || info.audioFormat !== 1 || info.channels !== target.channels || info.sampleRate !== target.sampleRate || info.bitsPerSample !== target.bitsPerSample || !info.hasData;
}

function needsConversion(filePath) {
  return needsConversionFor(filePath, null);
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
  // Treat only near-digital-zero as silence.  A fixed value of 8 used to
  // discard very quiet but valid dialogue before VAD/Whisper could recover it.
  if (!isFinite(threshold) || threshold < 0) threshold = 2;
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

function percentile(values, value) {
  if (!values.length) return -140;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var position = Math.max(0, Math.min(1, value)) * (sorted.length - 1);
  var lower = Math.floor(position);
  var upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function dynamicNoiseFloors(levels, windowMs, options) {
  var floorWindowMs = Number(options.noiseFloorWindowMs);
  if (!isFinite(floorWindowMs) || floorWindowMs < 500) floorWindowMs = 2000;
  var blockWindows = Math.max(1, Math.round(floorWindowMs / windowMs));
  var floorPercentile = Number(options.noiseFloorPercentile);
  if (!isFinite(floorPercentile) || floorPercentile < 0.05 || floorPercentile > 0.5) floorPercentile = 0.2;
  var blockFloors = [];
  for (var start = 0; start < levels.length; start += blockWindows) {
    blockFloors.push(percentile(levels.slice(start, Math.min(levels.length, start + blockWindows)), floorPercentile));
  }
  // A speech-heavy block can raise its own percentile. The three-block median
  // rejects that isolated rise while still following a lasting noise-floor step.
  var smoothed = blockFloors.map(function (floor, index) {
    var neighbours = [blockFloors[Math.max(0, index - 1)], floor, blockFloors[Math.min(blockFloors.length - 1, index + 1)]];
    neighbours.sort(function (a, b) { return a - b; });
    return neighbours[1];
  });
  return levels.map(function (_, index) { return smoothed[Math.min(smoothed.length - 1, Math.floor(index / blockWindows))]; });
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
  var margin = Number(options.marginDb);
  if (!isFinite(margin) || margin < 3) margin = 8;
  var hysteresis = Number(options.hysteresisDb);
  if (!isFinite(hysteresis) || hysteresis < 1 || hysteresis >= margin) hysteresis = Math.min(4, margin - 1);
  var lowMargin = Math.max(2, margin - hysteresis);
  var minDb = options.minDb === undefined || options.minDb === null || options.minDb === "" ? -48 : Number(options.minDb);
  if (!isFinite(minDb)) minDb = -48;
  var minPeak = Number(options.minPeak);
  if (!isFinite(minPeak) || minPeak <= 0) minPeak = 0.003;
  var noiseFloors = dynamicNoiseFloors(levels, windowMs, options);
  var lowStartMs = Number(options.lowStartMs);
  if (!isFinite(lowStartMs) || lowStartMs < windowMs) lowStartMs = 100;
  var lowStartWindows = Math.max(1, Math.round(lowStartMs / windowMs));
  var active = levels.map(function () { return false; });
  var inSpeech = false;
  var lowRunStart = -1;
  var onsetIndex;
  for (var activityIndex = 0; activityIndex < levels.length; activityIndex += 1) {
    var peakReady = peaks[activityIndex] >= minPeak;
    var highReady = peakReady && levels[activityIndex] >= Math.max(minDb, noiseFloors[activityIndex] + margin);
    var lowReady = peakReady && levels[activityIndex] >= Math.max(minDb, noiseFloors[activityIndex] + lowMargin);
    if (inSpeech && lowReady) {
      active[activityIndex] = true;
      continue;
    }
    if (inSpeech) inSpeech = false;
    if (highReady) {
      var onset = lowRunStart >= 0 ? lowRunStart : activityIndex;
      for (onsetIndex = onset; onsetIndex <= activityIndex; onsetIndex += 1) active[onsetIndex] = true;
      inSpeech = true;
      lowRunStart = -1;
    } else if (lowReady) {
      if (lowRunStart < 0) lowRunStart = activityIndex;
      // Sustained low-threshold energy can start a quiet utterance even when it
      // never contains a high-threshold peak.
      if (activityIndex - lowRunStart + 1 >= lowStartWindows) {
        for (onsetIndex = lowRunStart; onsetIndex <= activityIndex; onsetIndex += 1) active[onsetIndex] = true;
        inSpeech = true;
        lowRunStart = -1;
      }
    } else lowRunStart = -1;
  }
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

function reversePcm16Buffer(buffer, channels) {
  channels = Number(channels);
  if (!isFinite(channels) || Math.floor(channels) !== channels || channels < 1) channels = 1;
  var frameBytes = channels * 2;
  var frameCount = Math.floor(buffer.length / frameBytes);
  for (var leftFrame = 0, rightFrame = frameCount - 1; leftFrame < rightFrame; leftFrame += 1, rightFrame -= 1) {
    var leftOffset = leftFrame * frameBytes;
    var rightOffset = rightFrame * frameBytes;
    for (var channel = 0; channel < channels; channel += 1) {
      var first = buffer.readInt16LE(leftOffset + channel * 2);
      buffer.writeInt16LE(buffer.readInt16LE(rightOffset + channel * 2), leftOffset + channel * 2);
      buffer.writeInt16LE(first, rightOffset + channel * 2);
    }
  }
  return buffer;
}

function reversePcm16File(filePath) {
  var info = inspectWav(filePath);
  if (!info.valid || info.audioFormat !== 1 || info.channels < 1 || info.channels > 2 || info.bitsPerSample !== 16 || !info.hasData) throw new Error("reverse requires mono or stereo PCM16 WAV");
  var fd = fs.openSync(filePath, "r+");
  var frameBytes = info.channels * 2;
  var leftSample = 0;
  var rightSample = Math.floor(info.dataSize / frameBytes);
  var maxSamples = 32768;
  try {
    while (rightSample - leftSample > 1) {
      var count = Math.min(maxSamples, Math.floor((rightSample - leftSample) / 2));
      if (!count) break;
      var leftBytes = Buffer.alloc ? Buffer.alloc(count * frameBytes) : new Buffer(count * frameBytes);
      var rightBytes = Buffer.alloc ? Buffer.alloc(count * frameBytes) : new Buffer(count * frameBytes);
      var rightStart = rightSample - count;
      fs.readSync(fd, leftBytes, 0, leftBytes.length, info.dataOffset + leftSample * frameBytes);
      fs.readSync(fd, rightBytes, 0, rightBytes.length, info.dataOffset + rightStart * frameBytes);
      reversePcm16Buffer(leftBytes, info.channels);
      reversePcm16Buffer(rightBytes, info.channels);
      fs.writeSync(fd, rightBytes, 0, rightBytes.length, info.dataOffset + leftSample * frameBytes);
      fs.writeSync(fd, leftBytes, 0, leftBytes.length, info.dataOffset + rightStart * frameBytes);
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
  var target = targetAudioFormat(options);
  var expectedDurationMs = Number(options.expectedDurationMs);
  var hasExpectedDuration = isFinite(expectedDurationMs) && expectedDurationMs > 0;
  var conversionRequired = needsConversionFor(inputPath, target) || trimRange || reverse || Math.abs(rate - 1) > 0.000001 || hasExpectedDuration;
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
  args.push("-map", "0:a:0?", "-vn", "-ac", String(target.channels), "-ar", String(target.sampleRate), "-c:a", "pcm_s16le", partial);
  return processController.spawnProcess(ffmpegPath, args, { cwd: path.dirname(partial), timeoutMs: options.timeoutMs || 15 * 60 * 1000, cancelled: options.cancelled, onStderr: options.onStderr }, function (error) {
    if (error) {
      try { fs.unlinkSync(partial); } catch (ignore) {}
      return callback(error.code === errors.ERROR_CODES.JOB_CANCELED ? error : errors.makeError(errors.ERROR_CODES.AUDIO_CONVERT_FAILED, "FFmpeg 音频转换失败", { reason: error.message }));
    }
    try {
      var info = inspectWav(partial);
      if (!info.valid || !info.hasData || info.audioFormat !== 1 || info.channels !== target.channels || info.sampleRate !== target.sampleRate || info.bitsPerSample !== target.bitsPerSample) throw new Error("invalid output wav");
      if (reverse) reversePcm16File(partial);
      fs.renameSync(partial, outputPath);
    } catch (renameError) {
      try { fs.unlinkSync(partial); } catch (ignore) {}
      return callback(errors.makeError(errors.ERROR_CODES.AUDIO_CONVERT_FAILED, "输出 WAV 无效", { reason: renameError.message }));
    }
    callback(null, outputPath);
  });
}

module.exports = { prepareAudio: prepareAudio, needsConversion: needsConversion, needsConversionFor: needsConversionFor, targetAudioFormat: targetAudioFormat, inspectWav: inspectWav, hasAudioSignal: hasAudioSignal, detectSpeechRegions: detectSpeechRegions, partialWavPath: partialWavPath, atempoFilters: atempoFilters, reversePcm16Buffer: reversePcm16Buffer, reversePcm16File: reversePcm16File };
