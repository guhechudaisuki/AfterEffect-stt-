"use strict";

var os = require("os");
var fs = require("fs");
var path = require("path");
var processController = require("./process-controller");

function nvidiaSmiCandidates() {
  var values = ["nvidia-smi.exe", "C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Windows\\Sysnative\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"];
  var pathValue = process.env.PATH || "";
  pathValue.split(path.delimiter).forEach(function (directory) { if (directory) values.push(path.join(directory, "nvidia-smi.exe")); });
  return values.filter(function (value, index) {
    if (values.indexOf(value) !== index) return false;
    if (value === "nvidia-smi.exe") return true;
    try { return fs.statSync(value).isFile(); } catch (ignore) { return false; }
  });
}

function vulkanInfoCandidates() {
  var values = ["vulkaninfo.exe", "C:\\Windows\\System32\\vulkaninfo.exe", "C:\\Windows\\Sysnative\\vulkaninfo.exe"];
  var pathValue = process.env.PATH || "";
  pathValue.split(path.delimiter).forEach(function (directory) { if (directory) values.push(path.join(directory, "vulkaninfo.exe")); });
  return values.filter(function (value, index) {
    if (values.indexOf(value) !== index) return false;
    if (value === "vulkaninfo.exe") return true;
    try { return fs.statSync(value).isFile(); } catch (ignore) { return false; }
  });
}

function vulkanDriverCandidates() {
  return [
    "C:\\Windows\\System32\\vulkan-1.dll",
    "C:\\Windows\\Sysnative\\vulkan-1.dll",
    "C:\\Windows\\SysWOW64\\vulkan-1.dll"
  ];
}

function profile() {
  var cpus = os.cpus() || [];
  var result = {
    platform: process.platform,
    arch: process.arch,
    cpu: {
      model: cpus.length ? cpus[0].model : "Unknown CPU",
      logicalCores: cpus.length,
      recommendedThreads: Math.max(1, Math.min(16, Math.floor((cpus.length || 2) / 2)))
    },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    gpus: [],
    gpu: false,
    vulkan: false
  };
  var probe = null;
  var smiPaths = nvidiaSmiCandidates();
  for (var probeIndex = 0; probeIndex < smiPaths.length; probeIndex += 1) {
    probe = processController.spawnSync(smiPaths[probeIndex], ["--query-gpu=index,name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"], { timeoutMs: 3000 });
    if (probe.code === 0) break;
  }
  if (probe && probe.code === 0) {
    String(probe.stdout).trim().split(/\r?\n/).forEach(function (line) {
      if (!line) return;
      var parts = line.split(",").map(function (part) { return part.trim(); });
      result.gpus.push({ index: Number(parts[0]), name: parts[1], totalMiB: Number(parts[2]), freeMiB: Number(parts[3]), driver: parts[4], vendor: "nvidia" });
    });
  }
  result.gpu = result.gpus.length > 0;
  var vulkanPaths = vulkanInfoCandidates();
  for (var vulkanIndex = 0; vulkanIndex < vulkanPaths.length; vulkanIndex += 1) {
    var vulkanProbe = processController.spawnSync(vulkanPaths[vulkanIndex], ["--summary"], { timeoutMs: 5000 });
    if (vulkanProbe.code === 0 && /vulkan|gpu|device/i.test(String(vulkanProbe.stdout || "") + String(vulkanProbe.stderr || ""))) {
      result.vulkan = true;
      break;
    }
  }
  if (!result.vulkan) {
    result.vulkan = vulkanDriverCandidates().some(function (candidate) {
      try { return fs.statSync(candidate).isFile(); } catch (ignore) { return false; }
    });
  }
  return result;
}

function chooseDevice(runtime, model, hardware, policy) {
  hardware = hardware || profile();
  policy = policy || "auto";
  var devices = runtime && runtime.devices || ["cpu"];
  var gpus = Array.isArray(hardware.gpus) ? hardware.gpus : [];
  function chooseVulkanIndex() {
    var vulkanDevices = runtime && Array.isArray(runtime.vulkanDevices) ? runtime.vulkanDevices : [];
    if (!vulkanDevices.length) return 0;
    for (var i = 0; i < vulkanDevices.length; i += 1) {
      if (vulkanDevices[i] && vulkanDevices[i].uma === false) return vulkanDevices[i].index;
      if (vulkanDevices[i] && /nvidia|radeon|arc|geforce|rtx|rx\s/i.test(vulkanDevices[i].name || "")) return vulkanDevices[i].index;
    }
    return vulkanDevices[0].index;
  }
  if (policy === "cpu") return { device: "cpu", reason: "user", available: true };
  if (policy === "hybrid") {
    if (hardware.vulkan && devices.indexOf("vulkan") >= 0) {
      return { device: "vulkan", deviceIndex: chooseVulkanIndex(), reason: "vulkanGpuCpu", available: true, hybrid: true };
    }
    return { device: "cpu", reason: "vulkanUnavailable", available: false, hybrid: false };
  }
  var wantsGpu = policy === "gpu" || policy === "cuda" || policy === "auto";
  if (wantsGpu && hardware.gpu && devices.indexOf("cuda") >= 0) {
    var modelMiB = model && model.sizeBytes ? Math.ceil(model.sizeBytes / 1048576) : 0;
    var requiredMiB = runtime && runtime.engine === "transformers-whisper" ?
      (modelMiB ? Math.ceil(modelMiB * 1.5) + 1792 : 4096) :
      (modelMiB ? Math.ceil(modelMiB * 1.25) + 768 : 2048);
    var candidates = gpus.filter(function (gpu) { return Number(gpu.freeMiB) >= requiredMiB; });
    candidates.sort(function (a, b) { return b.freeMiB - a.freeMiB; });
    if (candidates.length) return { device: "cuda", deviceIndex: candidates[0].index, reason: "available", available: true, gpu: candidates[0], hybrid: false };
    if (policy === "auto" && runtime && runtime.capabilities && runtime.capabilities.hybridDevice) {
      return { device: "cuda", deviceIndex: gpus[0] && gpus[0].index !== undefined ? gpus[0].index : 0, reason: "hybridGpuCpu", available: true, gpu: gpus[0] || null, hybrid: true };
    }
  }
  if (policy === "auto" && hardware.vulkan && devices.indexOf("vulkan") >= 0) {
    return { device: "vulkan", deviceIndex: chooseVulkanIndex(), reason: "vulkanGpuCpu", available: true, hybrid: true };
  }
  return { device: "cpu", reason: policy === "auto" ? "gpuUnavailableOrInsufficient" : "gpuUnavailable", available: policy === "auto" };
}

module.exports = { profile: profile, chooseDevice: chooseDevice };
