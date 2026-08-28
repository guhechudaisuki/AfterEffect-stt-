"use strict";

function compatible(model, runtime) {
  if (!model || !runtime) return false;
  if ((runtime.supportedModelFormats || []).indexOf(model.format) < 0 || runtime.status !== "ready") return false;
  // Word timestamps are required for the subtitle timing contract. VAD is an
  // enhancement: Python/OpenAI Whisper can still run with pause/punctuation
  // segmentation when no VAD model is installed.
  if (runtime.capabilities && runtime.capabilities.wordTimestamps === false) return false;
  return true;
}

function score(model, runtime, hardware) {
  if (!compatible(model, runtime)) return 0;
  var devices = runtime.devices || ["cpu"];
  var formats = runtime.supportedModelFormats || [];
  var value = 50;
  if (runtime.origin === "managed") value += 20;
  if (runtime.engine === "whisper.cpp") value += 15;
  if (hardware && hardware.gpu && devices.indexOf("cuda") >= 0) value += 10;
  if (hardware && hardware.vulkan && devices.indexOf("vulkan") >= 0) value += 12;
  if (model.format === "gguf" && formats.indexOf("gguf") >= 0) value += 5;
  return value;
}

function matchModelsToRuntimes(models, runtimes, hardware) {
  var pairs = [];
  (models || []).forEach(function (model) {
    (runtimes || []).forEach(function (runtime) {
      var isCompatible = compatible(model, runtime);
      var devices = runtime.devices || ["cpu"];
      var recommendedDevice = hardware && hardware.vulkan && devices.indexOf("vulkan") >= 0 ? "vulkan" : hardware && hardware.gpu && devices.indexOf("cuda") >= 0 ? "cuda" : "cpu";
      pairs.push({ modelId: model.id, runtimeId: runtime.id, compatible: isCompatible, score: score(model, runtime, hardware), recommendedDevice: recommendedDevice, missing: isCompatible ? [] : ["compatibleRuntime"], warnings: isCompatible && runtime.capabilities && runtime.capabilities.vad === false ? ["W_VAD_UNAVAILABLE"] : [] });
    });
  });
  return pairs;
}

function annotateModels(models, runtimes, hardware) {
  var pairs = matchModelsToRuntimes(models, runtimes, hardware);
  return (models || []).map(function (model) {
    var candidates = pairs.filter(function (pair) { return pair.modelId === model.id && pair.compatible; }).sort(function (a, b) { return b.score - a.score; });
    model.runtimeCandidates = candidates;
    model.compatible = candidates.length > 0;
    model.status = candidates.length ? "ready" : "runtimeMissing";
    return model;
  });
}

module.exports = { compatible: compatible, score: score, matchModelsToRuntimes: matchModelsToRuntimes, annotateModels: annotateModels };
