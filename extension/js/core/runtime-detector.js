"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var cp = require("child_process");

function uniquePaths(values) {
  var seen = {};
  return (values || []).filter(function (value) {
    if (!value) return false;
    var key = path.resolve(value).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function findExecutables(extraRoots, pythonPaths) {
  var names = ["whisper-cli.exe", "main.exe", "whisper.exe", "ffmpeg.exe"];
  var directories = [];
  var directFiles = [];
  var explicitFfmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG_EXE;
  if (explicitFfmpeg) directFiles.push(explicitFfmpeg);
  (extraRoots || []).forEach(function (root) {
    if (!root) return;
    try {
      var stat = fs.statSync(root);
      if (stat.isFile()) directFiles.push(root);
      else if (stat.isDirectory()) directories.push(root);
    } catch (ignore) {}
  });
  (pythonPaths || []).forEach(function (pythonPath) {
    if (!pythonPath) return;
    var resolved = path.resolve(pythonPath);
    var directory = resolved;
    try { if (fs.statSync(resolved).isFile()) directory = path.dirname(resolved); } catch (ignore) { directory = path.dirname(resolved); }
    directories.push(directory);
    directories.push(path.join(directory, "Scripts"));
    directories.push(path.join(directory, "Library", "bin"));
    directories.push(path.dirname(directory));
  });
  (process.env.PATH || "").split(path.delimiter).forEach(function (directory) {
    if (directory) directories.push(directory);
  });
  uniquePaths(directories).forEach(function (directory) {
    names.forEach(function (name) {
      var file = path.join(directory, name);
      try { if (fs.statSync(file).isFile()) directFiles.push(file); } catch (ignore) {}
    });
  });
  return uniquePaths(directFiles);
}

function existingDirectories(parent) {
  try {
    return fs.readdirSync(parent).filter(function (entry) {
      try { return fs.statSync(path.join(parent, entry)).isDirectory(); } catch (ignore) { return false; }
    }).map(function (entry) { return path.join(parent, entry); });
  } catch (ignore) { return []; }
}

function fixedDriveRoots() {
  var roots = [];
  for (var code = 67; code <= 90; code += 1) {
    var root = String.fromCharCode(code) + ":\\";
    try { if (fs.statSync(root).isDirectory()) roots.push(root); } catch (ignore) {}
  }
  return roots;
}

function findCondaRoots(driveRoots) {
  var home = process.env.USERPROFILE || "";
  var local = process.env.LOCALAPPDATA || "";
  var programData = process.env.ProgramData || "";
  var names = ["Miniconda", "Miniconda3", "Anaconda", "Anaconda3", "Mambaforge", "Miniforge", "Miniforge3"];
  var roots = [];
  function add(root) {
    if (!root) return;
    try { if (fs.statSync(root).isDirectory()) roots.push(root); } catch (ignore) {}
  }
  [process.env.CONDA_PREFIX, home, local, programData, "C:\\"].forEach(function (parent) {
    names.forEach(function (name) { add(parent ? path.join(parent, name) : null); });
  });
  try {
    fs.readFileSync(path.join(home, ".conda", "environments.txt"), "utf8").split(/\r?\n/).forEach(function (root) { add(root.trim()); });
  } catch (ignore) {}
  (driveRoots || fixedDriveRoots()).forEach(function (driveRoot) {
    existingDirectories(driveRoot).forEach(function (directory) {
      if (names.some(function (name) { return name.toLowerCase() === path.basename(directory).toLowerCase(); })) add(directory);
      names.forEach(function (name) { add(path.join(directory, name)); });
    });
  });
  return uniquePaths(roots);
}

function pythonCandidates(explicitPaths) {
  var home = process.env.USERPROFILE || "";
  var local = process.env.LOCALAPPDATA || "";
  var names = ["python.exe", "py.exe"];
  var candidates = (explicitPaths || []).slice();
  (process.env.PATH || "").split(path.delimiter).forEach(function (directory) {
    if (!directory) return;
    names.forEach(function (name) { candidates.push(path.join(directory, name)); });
  });
  [
    local ? path.join(local, "Programs", "Python") : null,
    "C:\\Python310", "C:\\Python311", "C:\\Python312", "C:\\Python313"
  ].forEach(function (root) {
    if (!root) return;
    names.forEach(function (name) { candidates.push(path.join(root, name)); });
    try {
      fs.readdirSync(root).forEach(function (entry) {
        names.forEach(function (name) { candidates.push(path.join(root, entry, name)); });
      });
    } catch (ignore) {}
  });
  findCondaRoots().forEach(function (root) {
    candidates.push(path.join(root, "python.exe"));
    existingDirectories(path.join(root, "envs")).forEach(function (environment) {
      candidates.push(path.join(environment, "python.exe"));
    });
  });
  return uniquePaths(candidates).filter(function (file) {
    try { return fs.statSync(file).isFile(); } catch (ignore) { return false; }
  });
}

function spawnProbe(command, args, timeout) {
  try {
    var result = cp.spawnSync(command, args, { windowsHide: true, shell: false, timeout: timeout || 5000, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error || null };
  } catch (error) {
    return { status: -1, stdout: "", stderr: String(error && error.message || error), error: error };
  }
}

function readLastJsonLine(text) {
  var lines = String(text || "").trim().split(/\r?\n/);
  for (var i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch (ignore) {}
  }
  return null;
}

function probePython(file, probeScript) {
  var result;
  var outputPath;
  if (probeScript && fs.existsSync(probeScript)) {
    outputPath = path.join(os.tmpdir(), "lws-python-probe-" + crypto.randomBytes(8).toString("hex") + ".json");
    // Importing PyTorch can take more than eight seconds on a cold Windows environment.
    result = spawnProbe(file, ["-E", "-s", probeScript, "--json-output", outputPath], 30000);
  } else {
    var code = "import importlib.util,json,platform,sys;mods={};[mods.__setitem__(m,bool(importlib.util.find_spec(m))) for m in ['whisper','faster_whisper','ctranslate2','torch','transformers','accelerate']];print(json.dumps({'status':'ready','python':sys.version,'arch':platform.architecture()[0],'modules':mods}))";
    result = spawnProbe(file, ["-E", "-s", "-c", code], 5000);
  }
  var parsed = null;
  if (outputPath) {
    try { parsed = JSON.parse(fs.readFileSync(outputPath, "utf8")); } catch (ignore) {}
    try { fs.unlinkSync(outputPath); } catch (ignore) {}
  }
  if (!parsed) parsed = readLastJsonLine(result.stdout);
  if (result.status !== 0 || !parsed) {
    return { status: "probeFailed", path: file, error: (result.stderr || "invalid python probe response").slice(-500) };
  }
  parsed.status = "ready";
  parsed.path = file;
  return parsed;
}

function descriptorsFromPythonProbe(file, probe, bridgePath) {
  var modules = probe && probe.modules || {};
  var descriptors = [];
  var common = {
    executable: path.resolve(file),
    bridgePath: bridgePath,
    status: probe && probe.status === "ready" ? "ready" : "probeFailed",
    version: probe && probe.python || null,
    arch: probe && probe.arch || null,
    origin: probe && probe.origin || "system",
    diagnostics: []
  };
  if (modules.whisper && modules.torch) {
    descriptors.push({
      id: "openai-whisper:" + common.executable.toLowerCase(),
      engine: "openai-whisper",
      executable: common.executable,
      bridgePath: common.bridgePath,
      status: common.status,
      version: common.version,
      arch: common.arch,
      origin: common.origin,
      supportedModelFormats: ["openai-pt"],
      devices: probe.torchCuda || probe.cuda ? ["cpu", "cuda"] : ["cpu"],
      computeTypes: probe.torchCuda || probe.cuda ? ["float32", "float16"] : ["float32"],
       capabilities: { wordTimestamps: true, vad: false },
      diagnostics: common.diagnostics,
      probe: probe
    });
  }
  if (modules.faster_whisper && modules.ctranslate2) {
    descriptors.push({
      id: "faster-whisper:" + common.executable.toLowerCase(),
      engine: "faster-whisper",
      executable: common.executable,
      bridgePath: common.bridgePath,
      status: common.status,
      version: common.version,
      arch: common.arch,
      origin: common.origin,
      supportedModelFormats: ["ctranslate2"],
      devices: probe.ctranslate2Cuda || probe.cuda ? ["cpu", "cuda"] : ["cpu"],
      computeTypes: probe.computeTypes || ["int8", "float32"],
      capabilities: { wordTimestamps: true, vad: true },
      diagnostics: common.diagnostics,
      probe: probe
    });
  }
  if (modules.transformers && modules.torch) {
    descriptors.push({
      id: "transformers-whisper:" + common.executable.toLowerCase(),
      engine: "transformers-whisper",
      executable: common.executable,
      bridgePath: common.bridgePath,
      status: common.status,
      version: common.version,
      arch: common.arch,
      origin: common.origin,
      supportedModelFormats: ["huggingface-whisper"],
      devices: probe.torchCuda || probe.cuda ? ["cpu", "cuda"] : ["cpu"],
      computeTypes: probe.torchCuda || probe.cuda ? ["float32", "float16"] : ["float32"],
       capabilities: { wordTimestamps: true, vad: false, hybridDevice: !!modules.accelerate },
      diagnostics: common.diagnostics,
      probe: probe
    });
  }
  return descriptors;
}

function firstSupportedFlag(text, flags) {
  var source = String(text || "");
  for (var i = 0; i < flags.length; i += 1) {
    // Do not use a plain substring search here: for example `--vad` is also
    // a prefix of `--vad-model`, and `-tp` is a prefix of `-tpi`.  Emitting a
    // flag that only happens to be part of another option makes probing
    // unreliable across whisper.cpp releases.  A token boundary is enough
    // for the plain-text output produced by `--help` while still accepting
    // punctuation (the help formatter prints a comma after short aliases).
    var escaped = String(flags[i]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var pattern = new RegExp("(^|[^A-Za-z0-9_-])" + escaped + "(?=$|[^A-Za-z0-9_-])", "i");
    if (pattern.test(source)) return flags[i];
  }
  return null;
}

function parseWhisperCppProbe(file, text, origin) {
  var sourceText = String(text || "");
  var lower = String(text || "").toLowerCase();
  var jsonFull = firstSupportedFlag(lower, ["--output-json-full", "-ojf"]);
  var json = firstSupportedFlag(lower, ["--output-json", "-oj"]);
  var vad = firstSupportedFlag(lower, ["--vad"]);
  var vadModel = firstSupportedFlag(lower, ["--vad-model"]);
  var vadThreshold = firstSupportedFlag(lower, ["--vad-threshold", "-vt"]);
  var vadMinSpeechDurationMs = firstSupportedFlag(lower, ["--vad-min-speech-duration-ms", "-vspd"]);
  var vadMinSilenceDurationMs = firstSupportedFlag(lower, ["--vad-min-silence-duration-ms", "-vsd"]);
  var vadMaxSpeechDurationS = firstSupportedFlag(lower, ["--vad-max-speech-duration-s", "-vmsd"]);
  var vadSpeechPadMs = firstSupportedFlag(lower, ["--vad-speech-pad-ms", "-vp"]);
  var vadSamplesOverlap = firstSupportedFlag(lower, ["--vad-samples-overlap", "-vo"]);
  var noGpu = firstSupportedFlag(lower, ["--no-gpu", "-ng"]);
  var maxContext = firstSupportedFlag(lower, ["--max-context", "-mc"]);
  var maxLen = firstSupportedFlag(lower, ["--max-len", "-ml"]);
  var bestOf = firstSupportedFlag(lower, ["--best-of", "-bo"]);
  var beamSize = firstSupportedFlag(lower, ["--beam-size", "-bs"]);
  var audioCtx = firstSupportedFlag(lower, ["--audio-ctx", "-ac"]);
  var wordThold = firstSupportedFlag(lower, ["--word-thold", "-wt"]);
  var entropyThold = firstSupportedFlag(lower, ["--entropy-thold", "-et"]);
  var splitOnWord = firstSupportedFlag(lower, ["--split-on-word", "-sow"]);
  var noSpeechThreshold = firstSupportedFlag(lower, ["--no-speech-thold", "-nth"]);
  var logprobThreshold = firstSupportedFlag(lower, ["--logprob-thold", "-lpt"]);
  var temperature = firstSupportedFlag(lower, ["--temperature", "-tp"]);
  var temperatureInc = firstSupportedFlag(lower, ["--temperature-inc", "-tpi"]);
  var noFallback = firstSupportedFlag(lower, ["--no-fallback", "-nf"]);
  var prompt = firstSupportedFlag(lower, ["--prompt"]);
  var carryInitialPrompt = firstSupportedFlag(lower, ["--carry-initial-prompt"]);
  var suppressNst = firstSupportedFlag(lower, ["--suppress-nst", "-sns"]);
  var suppressRegex = firstSupportedFlag(lower, ["--suppress-regex"]);
  var flashAttn = firstSupportedFlag(lower, ["--flash-attn", "-fa"]);
  var noFlashAttn = firstSupportedFlag(lower, ["--no-flash-attn", "-nfa"]);
  var printConfidence = firstSupportedFlag(lower, ["--print-confidence"]);
  var logScore = firstSupportedFlag(lower, ["--log-score", "-ls"]);
  var device = firstSupportedFlag(lower, ["--device", "-dev"]);
  var formats = ["ggml-bin"];
  if (/\bgguf\b/.test(lower)) formats.push("gguf");
  var devices = ["cpu"];
  if (/\bcuda\b|\bcublas\b/.test(lower)) devices.push("cuda");
  if (/\bvulkan\b/.test(lower)) devices.push("vulkan");
  var vulkanDevices = [];
  var vulkanDevicePattern = /ggml_vulkan:\s*(\d+)\s*=\s*([^\r\n|]+)(?:\s*\|[^\r\n]*)?/gi;
  var vulkanMatch;
  while ((vulkanMatch = vulkanDevicePattern.exec(sourceText))) {
    vulkanDevices.push({ index: Number(vulkanMatch[1]), name: vulkanMatch[2].trim() });
  }
  var vadParameterFlags = [vadThreshold, vadMinSpeechDurationMs, vadMinSilenceDurationMs, vadMaxSpeechDurationS, vadSpeechPadMs, vadSamplesOverlap];
  var decoderParameterFlags = [maxContext, maxLen, bestOf, beamSize, audioCtx, wordThold, entropyThold, splitOnWord, noSpeechThreshold, logprobThreshold, temperature, temperatureInc, noFallback, prompt, carryInitialPrompt, suppressNst, suppressRegex, flashAttn, noFlashAttn];
  return {
    id: "whispercpp:" + path.resolve(file).toLowerCase(),
    engine: "whisper.cpp",
    executable: path.resolve(file),
    status: /whisper/.test(lower) ? "ready" : "probeFailed",
    origin: origin || "system",
    supportedModelFormats: formats,
    devices: devices,
    vulkanDevices: vulkanDevices,
    flags: {
      json: json || false,
      jsonFull: jsonFull || false,
      vad: vad || false,
      vadModel: vadModel || false,
      vadThreshold: vadThreshold || false,
      vadMinSpeechDurationMs: vadMinSpeechDurationMs || false,
      vadMinSilenceDurationMs: vadMinSilenceDurationMs || false,
      vadMaxSpeechDurationS: vadMaxSpeechDurationS || false,
      vadSpeechPadMs: vadSpeechPadMs || false,
      vadSamplesOverlap: vadSamplesOverlap || false,
      noGpu: noGpu || false,
      maxContext: maxContext || false,
      maxLen: maxLen || false,
      bestOf: bestOf || false,
      beamSize: beamSize || false,
      audioCtx: audioCtx || false,
      wordThold: wordThold || false,
      entropyThold: entropyThold || false,
      splitOnWord: splitOnWord || false,
      noSpeechThreshold: noSpeechThreshold || false,
      logprobThreshold: logprobThreshold || false,
      temperature: temperature || false,
      temperatureInc: temperatureInc || false,
      noFallback: noFallback || false,
      prompt: prompt || false,
      carryInitialPrompt: carryInitialPrompt || false,
      suppressNst: suppressNst || false,
      suppressRegex: suppressRegex || false,
      flashAttn: flashAttn || false,
      noFlashAttn: noFlashAttn || false,
      printConfidence: printConfidence || false,
      logScore: logScore || false,
      device: device || false
    },
    // Full JSON is the probeable whisper.cpp capability that exposes timed tokens.
    // Do not add --dtw: it is a model-specific alignment option, not a universal CLI flag.
    capabilities: {
      wordTimestamps: !!jsonFull,
      vad: !!vad && !!vadModel,
      vadParameters: !!vad && !!vadModel && vadParameterFlags.some(function (flag) { return !!flag; }),
      prompt: !!prompt,
      initialPrompt: !!prompt,
      decoderParameters: decoderParameterFlags.some(function (flag) { return !!flag; }),
      quality: !!jsonFull,
      tokenProbabilities: !!jsonFull,
      printConfidence: !!printConfidence,
      logScore: !!logScore,
      hybridDevice: devices.indexOf("vulkan") >= 0
    },
    diagnostics: []
  };
}

function detectRuntimes(options, callback) {
  options = options || {};
  var executables = findExecutables(options.extraRoots || [], options.pythonPaths || []);
  var runtimes = [];
  var ffmpeg = null;
  executables.forEach(function (file) {
    if (path.basename(file).toLowerCase() === "ffmpeg.exe") {
      var ffmpegProbe = spawnProbe(file, ["-version"], 3000);
      if (ffmpegProbe.status === 0 && /ffmpeg version/i.test(ffmpegProbe.stdout + ffmpegProbe.stderr)) ffmpeg = path.resolve(file);
      return;
    }
    var help = spawnProbe(file, ["--help"], 4000);
    var version = spawnProbe(file, ["--version"], 3000);
    var text = help.stdout + help.stderr + version.stdout + version.stderr;
    var descriptor = parseWhisperCppProbe(file, text, options.origin);
    if (descriptor.status === "ready") runtimes.push(descriptor);
  });
  var bridgePath = options.bridgePath || path.resolve(__dirname, "..", "..", "python", "whisper_bridge.py");
  var probeScript = options.probeScript || path.resolve(__dirname, "..", "..", "python", "runtime_probe.py");
  var pythonFiles = pythonCandidates(options.pythonPaths || []);
  pythonFiles.forEach(function (python) {
    var probe = probePython(python, probeScript);
    if (probe.status !== "ready") return;
    descriptorsFromPythonProbe(python, probe, bridgePath).forEach(function (runtime) { runtimes.push(runtime); });
  });
  process.nextTick(function () { callback(null, { runtimes: runtimes, ffmpeg: ffmpeg, pythonCandidates: pythonFiles }); });
}

module.exports = {
  detectRuntimes: detectRuntimes,
  probePython: probePython,
  descriptorsFromPythonProbe: descriptorsFromPythonProbe,
  parseWhisperCppProbe: parseWhisperCppProbe,
  findExecutables: findExecutables,
  pythonCandidates: pythonCandidates,
  findCondaRoots: findCondaRoots
};
