"use strict";

var fs = require("fs");

function finite(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

function normalizeRegions(regions, durationMs, paddingMs, mergeGapMs) {
  var duration = Math.max(0, Math.round(finite(durationMs, 0)));
  var padding = Math.max(0, Math.round(finite(paddingMs, 80)));
  var mergeGap = Math.max(0, Math.round(finite(mergeGapMs, 140)));
  var values = (Array.isArray(regions) ? regions : []).map(function (region) {
    var start = Math.round(finite(region && region.startMs, finite(region && region.start, 0) * 1000));
    var end = Math.round(finite(region && region.endMs, finite(region && region.end, 0) * 1000));
    return { startMs: Math.max(0, start - padding), endMs: Math.min(duration, end + padding) };
  }).filter(function (region) { return region.endMs > region.startMs; }).sort(function (a, b) {
    return a.startMs - b.startMs || a.endMs - b.endMs;
  });
  var merged = [];
  values.forEach(function (region) {
    var previous = merged[merged.length - 1];
    if (previous && region.startMs <= previous.endMs + mergeGap) previous.endMs = Math.max(previous.endMs, region.endMs);
    else merged.push(region);
  });
  return merged;
}

function isolatePcm16MonoWav(inputPath, outputPath, regions, options) {
  options = options || {};
  var input = fs.readFileSync(inputPath);
  if (input.length < 44 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") throw new Error("speech isolation requires a RIFF/WAVE file");
  var channels = input.readUInt16LE(22);
  var sampleRate = input.readUInt32LE(24);
  var bits = input.readUInt16LE(34);
  var dataOffset = input.indexOf(Buffer.from("data"), 12);
  if (channels !== 1 || bits !== 16 || sampleRate !== 16000 || dataOffset < 0 || dataOffset + 8 > input.length) throw new Error("speech isolation requires 16 kHz mono PCM16 WAV");
  var dataStart = dataOffset + 8;
  var dataSize = Math.min(input.readUInt32LE(dataOffset + 4), input.length - dataStart);
  var durationMs = dataSize / 2 / sampleRate * 1000;
  var normalized = normalizeRegions(regions, durationMs, options.paddingMs, options.mergeGapMs);
  if (!normalized.length) return false;
  var output = Buffer.from(input);
  var frameCount = Math.floor(dataSize / 2);
  var keep = Buffer.alloc(dataSize);
  normalized.forEach(function (region) {
    var startFrame = Math.max(0, Math.min(frameCount, Math.floor(region.startMs * sampleRate / 1000)));
    var endFrame = Math.max(startFrame, Math.min(frameCount, Math.ceil(region.endMs * sampleRate / 1000)));
    if (endFrame > startFrame) input.copy(keep, startFrame * 2, startFrame * 2, endFrame * 2);
  });
  keep.copy(output, dataStart);
  fs.writeFileSync(outputPath, output);
  return true;
}

module.exports = { normalizeRegions: normalizeRegions, isolatePcm16MonoWav: isolatePcm16MonoWav };
