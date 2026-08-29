"use strict";

var fs = require("fs");
var EventEmitter = require("events").EventEmitter;
var jobSchema = require("./job-schema");
var errors = require("./errors");
var defaultTempJobStore = require("./temp-job-store");
var defaultAudioPreprocessor = require("./audio-preprocessor");
var segmentUtils = require("./segment-utils");
var defaultHardwareProfiler = require("./hardware-profiler");
var whispercpp = require("./whispercpp-adapter");
var pythonAdapter = require("./python-adapter");
var defaultTranslationClient = require("./translation-client");
var defaultUvr5Preprocessor = require("./uvr5-preprocessor");
var defaultSpeechVad = require("./speech-vad");
var speechIsolator = require("./speech-isolator");

function TranscriptionRunner(options) {
  EventEmitter.call(this);
  this.options = options || {};
  this.active = null;
}

TranscriptionRunner.prototype = Object.create(EventEmitter.prototype);
TranscriptionRunner.prototype.constructor = TranscriptionRunner;

TranscriptionRunner.prototype.emitProgress = function (jobId, phase, phasePercent, detail) {
  this.emit("progress", { type: "progress", jobId: jobId, phase: phase, phasePercent: phasePercent, overallPercent: null, detail: detail || {} });
};

TranscriptionRunner.prototype.cancel = function () {
  if (!this.active || this.active.finished) return false;
  this.active.cancelled = true;
  if (this.active.controller && this.active.controller.cancel) this.active.controller.cancel();
  return true;
};

function computeTypeFor(runtime, job, device) {
  if (device === "cpu") {
    if (runtime.engine === "faster-whisper") return "int8";
    if (runtime.engine === "openai-whisper" || runtime.engine === "transformers-whisper") return "float32";
    return null;
  }
  if (job.transcription.computeType) return job.transcription.computeType;
  if (runtime.engine === "faster-whisper" || runtime.engine === "openai-whisper" || runtime.engine === "transformers-whisper") return "float16";
  return null;
}

function cleanupAttemptFiles(store) {
  ["whisper-output.json", "whisper-output.json.json", "python-result.json", "python-result.json.partial", "python-request.json"].forEach(function (name) {
    try { fs.unlinkSync(store.path(name)); } catch (ignore) {}
  });
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

function audioDurationMs(audioPreprocessor, audioPath, fallback) {
  try {
    if (audioPreprocessor && typeof audioPreprocessor.inspectWav === "function") {
      var info = audioPreprocessor.inspectWav(audioPath);
      if (info && info.valid && info.hasData && Number(info.sampleRate) > 0) {
        return Math.max(0, Number(info.dataSize) / (Number(info.sampleRate) * 2) * 1000);
      }
    }
  } catch (ignore) {}
  return Math.max(0, finiteNumber(fallback, 0));
}

function normaliseRegions(regions, durationMs, paddingMs, mergeGapMs) {
  try {
    return speechIsolator.normalizeRegions(regions, durationMs, paddingMs, mergeGapMs);
  } catch (ignore) {
    return [];
  }
}

function resolveApiKey(resolver, reference, callback) {
  if (!reference || !resolver) return process.nextTick(function () { callback(null, null); });
  var called = false;
  function done(error, value) {
    if (called) return;
    called = true;
    if (error) return callback(errors.makeError(errors.ERROR_CODES.TRANSLATION_AUTH, "无法读取翻译凭据", { reason: errors.redactText(error.message || error) }));
    callback(null, value === undefined || value === null ? null : String(value));
  }
  try {
    if (resolver.length >= 2) resolver(reference, done);
    else process.nextTick(function () { try { done(null, resolver(reference)); } catch (error) { done(error); } });
  } catch (error) { done(error); }
}

TranscriptionRunner.prototype.run = function (job, callback) {
  var self = this;
  try { jobSchema.validateJob(job); } catch (validationError) { return callback(validationError); }
  if (this.active) return callback(errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "已有转写任务正在运行"));
  var tempJobStore = this.options.tempJobStore || defaultTempJobStore;
  var audioPreprocessor = this.options.audioPreprocessor || defaultAudioPreprocessor;
  var hardwareProfiler = this.options.hardwareProfiler || defaultHardwareProfiler;
  var translationClient = this.options.translationClient || defaultTranslationClient;
  var uvr5Preprocessor = this.options.uvr5Preprocessor || defaultUvr5Preprocessor;
  var speechVad = this.options.speechVad || defaultSpeechVad;
  var adapters = this.options.adapters || { "whisper.cpp": whispercpp, "openai-whisper": pythonAdapter, "faster-whisper": pythonAdapter, "transformers-whisper": pythonAdapter };
  var store;
  try { store = tempJobStore.create(this.options.tempRoot, job.jobId); } catch (storeError) {
    return callback(errors.makeError(errors.ERROR_CODES.TEMP_PERMISSION, "无法创建任务临时目录", { reason: storeError.code || storeError.message }));
  }
  var state = { jobId: job.jobId, cancelled: false, controller: null, store: store, finished: false, warnings: [], gpuError: null, preprocessing: { uvr5: false, speechIsolation: false, inputPath: null } };
  this.active = state;
  var runtime = this.options.runtimeDescriptor || job.runtime;
  if (!runtime || !runtime.engine || !runtime.executable) return finish(errors.makeError(errors.ERROR_CODES.RUNTIME_NOT_FOUND, "没有可用的 Whisper 运行时"));
  var adapter = adapters[runtime.engine];
  if (!adapter || typeof adapter.run !== "function") return finish(errors.makeError(errors.ERROR_CODES.RUNTIME_INCOMPATIBLE, "运行时没有可用适配器", { engine: runtime.engine }));
  var model = this.options.modelDescriptor || job.model;
  if (runtime.capabilities && runtime.capabilities.vad === false) {
    state.warnings.push(errors.warning(errors.ERROR_CODES.VAD_UNAVAILABLE, "当前 Whisper 运行时没有可用 VAD，将使用词时间戳、标点和停顿断句"));
  }
  var hardware = this.options.hardware || hardwareProfiler.profile();
  var device = hardwareProfiler.chooseDevice(runtime, model, hardware, job.transcription.devicePolicy);
  if ((job.transcription.devicePolicy === "gpu" || job.transcription.devicePolicy === "cuda") && device.device !== "cuda") {
    return finish(errors.makeError(errors.ERROR_CODES.GPU_UNAVAILABLE, "用户指定 GPU，但没有兼容且空闲的 GPU 执行环境", { reason: device.reason }));
  }
  if (job.transcription.devicePolicy === "hybrid" && device.device !== "vulkan") {
    return finish(errors.makeError(errors.ERROR_CODES.GPU_UNAVAILABLE, "用户指定 GPU+CPU 混合，但没有可用的 Vulkan 执行环境", { reason: device.reason }));
  }
  var wavPath = store.path("audio.wav");
  var ffmpeg = this.options.ffmpegPath || job.ffmpegPath;
  self.emitProgress(job.jobId, "preparingAudio", 0);
  state.controller = audioPreprocessor.prepareAudio(job.audioInput.path, wavPath, ffmpeg, {
    startMs: job.audioInput.sourceStartMs,
    endMs: job.audioInput.sourceEndMs,
    playbackRate: job.audioInput.playbackRate,
    reverse: job.audioInput.reverse === true,
    expectedDurationMs: job.audioInput.timelineOutMs - job.audioInput.timelineInMs,
    cancelled: function () { return state.cancelled; },
    onStderr: function (chunk) { self.emit("log", { jobId: job.jobId, phase: "preparingAudio", text: errors.redactText(chunk) }); }
  }, function (audioError) {
    if (audioError) return finish(audioError);
    if (state.cancelled) return finish(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
    self.emitProgress(job.jobId, "preparingAudio", 100);
    if (audioPreprocessor.hasAudioSignal) {
      var hasSignal = true;
      try { hasSignal = audioPreprocessor.hasAudioSignal(wavPath, { threshold: 2 }); } catch (signalError) { hasSignal = true; }
      if (!hasSignal) {
        state.warnings.push(errors.warning(errors.ERROR_CODES.AUDIO_NO_SIGNAL, "该图层没有检测到音频波形，已跳过 STT", { layerId: job.audioInput.layerId || null }));
        return saveResult({
          schemaVersion: 1,
          jobId: job.jobId,
          status: "skipped",
          sourceLanguage: { code: job.transcription.language || "auto", probability: null },
          timeline: { inMs: job.audioInput.timelineInMs, outMs: job.audioInput.timelineOutMs },
          engine: { name: runtime.engine, version: runtime.version || null, device: device.device, computeType: null, fellBackFromGpu: false },
          segments: [],
          warnings: state.warnings.slice(),
          artifacts: {}
        });
      }
    }
    if (job.preprocessing && job.preprocessing.uvr5Enabled) {
      var uvrInputPath = store.path("uvr5-input.wav");
      var vocalPath = store.path("uvr5-vocal.wav");
      // UVR5 receives a 44.1 kHz conformed copy instead of the 16 kHz STT
      // waveform.  Separation models need upper-band detail; downsampling
      // before separation creates avoidable artifacts and lost consonants.
      state.controller = audioPreprocessor.prepareAudio(job.audioInput.path, uvrInputPath, ffmpeg, {
        startMs: job.audioInput.sourceStartMs,
        endMs: job.audioInput.sourceEndMs,
        playbackRate: job.audioInput.playbackRate,
        reverse: job.audioInput.reverse === true,
        expectedDurationMs: job.audioInput.timelineOutMs - job.audioInput.timelineInMs,
        targetSampleRate: 44100,
        // Keep stereo for UVR5's separation model; downmix only its output
        // for Whisper after the separation pass. Reversal is supported for
        // both channel layouts by the PCM helper.
        targetChannels: 2,
        cancelled: function () { return state.cancelled; },
        onStderr: function (chunk) { self.emit("log", { jobId: job.jobId, phase: "separatingVocals", text: errors.redactText(chunk) }); }
      }, function (uvrInputError) {
        if (uvrInputError) return finish(uvrInputError);
        self.emitProgress(job.jobId, "separatingVocals", 0);
        state.controller = uvr5Preprocessor.separate(uvrInputPath, vocalPath, job.preprocessing.uvr5Model, {
          bridgePath: self.options.uvr5BridgePath,
          ffmpegPath: ffmpeg,
          devicePolicy: job.transcription.devicePolicy,
          cancelled: function () { return state.cancelled; },
          onEvent: function (uvrEvent) { self.emitProgress(job.jobId, "separatingVocals", uvrEvent.percent === undefined ? null : uvrEvent.percent, uvrEvent); }
        }, function (uvrError) {
          if (uvrError) return finish(uvrError);
          if (state.cancelled) return finish(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
          var vocal16kPath = store.path("uvr5-vocal-16k.wav");
          state.controller = audioPreprocessor.prepareAudio(vocalPath, vocal16kPath, ffmpeg, {
            cancelled: function () { return state.cancelled; },
            onStderr: function (chunk) { self.emit("log", { jobId: job.jobId, phase: "separatingVocals", text: errors.redactText(chunk) }); }
          }, function (vocalConvertError) {
            if (vocalConvertError) return finish(vocalConvertError);
            state.preprocessing.uvr5 = true;
            state.preprocessing.uvr5InputSampleRate = 44100;
            state.preprocessing.inputPath = vocal16kPath;
            runWithSpeechDetection(device, false, vocal16kPath);
          });
        });
      });
      return;
    }
    runWithSpeechDetection(device, false, wavPath);
  });

  function runWithSpeechDetection(deviceChoice, fellBack, activeAudioPath) {
    var vadDescriptor = self.options.vadDescriptor;
    if (!vadDescriptor && self.options.vadModelPath && self.options.vadPythonExecutable && self.options.vadBridgePath) {
      vadDescriptor = { modelPath: self.options.vadModelPath, pythonExecutable: self.options.vadPythonExecutable, bridgePath: self.options.vadBridgePath };
    }
    if (speechVad && typeof speechVad.detect === "function" && vadDescriptor) {
      self.emitProgress(job.jobId, "detectingSpeech", 0);
      state.controller = speechVad.detect(activeAudioPath, vadDescriptor, store, {
        device: deviceChoice.device,
        cancelled: function () { return state.cancelled; },
        onEvent: function (event) { self.emitProgress(job.jobId, "detectingSpeech", event.percent === undefined ? null : event.percent, event); }
      }, function (vadError, regions) {
        if (vadError) {
          state.warnings.push(errors.warning(errors.ERROR_CODES.OUTPUT_INVALID, "FunASR VAD 失败，将使用本地能量边界", { reason: vadError.message }));
          return runWithDevice(deviceChoice, fellBack, activeAudioPath, null, "energy");
        }
        runWithDevice(deviceChoice, fellBack, activeAudioPath, regions || [], "funasr");
      });
      return;
    }
    runWithDevice(deviceChoice, fellBack, activeAudioPath, null, "energy");
  }

  function runWithDevice(deviceChoice, fellBack, activeAudioPath, detectedSpeechRegions, detectionSource, regionPlan) {
    if (state.cancelled) return finish(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
    self.emitProgress(job.jobId, "loadingModel", 0, { device: deviceChoice.device });
    var durationMs = audioDurationMs(audioPreprocessor, activeAudioPath, job.audioInput.timelineOutMs - job.audioInput.timelineInMs);
    var plan = regionPlan;
    if (!plan) {
      var neuralRegions = Array.isArray(detectedSpeechRegions) ? detectedSpeechRegions : [];
      var energyRegions = [];
      if (typeof audioPreprocessor.detectSpeechRegions === "function") {
        try {
          // Energy VAD is deliberately a boundary hint.  It must never erase
          // samples before Whisper because low-SNR speech may be missed by it.
          energyRegions = audioPreprocessor.detectSpeechRegions(activeAudioPath, {
            windowMs: 20,
            bridgeMs: 160,
            minSpeechMs: 60,
            marginDb: 6,
            hysteresisDb: 3,
            lowStartMs: 100,
            minDb: -54,
            minPeak: 0.0015
          }) || [];
        } catch (speechError) {
          state.warnings.push(errors.warning(errors.ERROR_CODES.OUTPUT_INVALID, "语音边界检测失败，将使用 Whisper 词时间戳", { reason: speechError.message }));
        }
      }
      var hasNeural = neuralRegions.length > 0;
      var trustedRegions = hasNeural ? normaliseRegions(neuralRegions, durationMs, 0, 120) : [];
      var boundaryRegions = normaliseRegions((hasNeural ? neuralRegions : []).concat(energyRegions), durationMs, 0, 120);
      // Only neural VAD is trusted enough to create independent decode clips.
      // Energy regions remain hints so quiet speech is not cut out.
      // Keep the authoritative region unpadded here.  The Python bridge adds
      // 240 ms only to the acoustic clip, then maps words back to this exact
      // VAD boundary.  Padding twice would shift/clamp subtitle timing.
      var decodeRegions = hasNeural ? normaliseRegions(neuralRegions, durationMs, 0, 180) : [];
      plan = {
        // Trusted regions are used only for conservative edge trimming.
        speechRegions: trustedRegions,
        speechBoundaryHints: boundaryRegions,
        decodeRegions: decodeRegions,
        source: hasNeural ? (energyRegions.length ? "funasr+energy" : "funasr") : (energyRegions.length ? "energy" : "none"),
        neural: hasNeural
      };
    }
    var speechRegions = plan.speechRegions || [];
    var speechBoundaryHints = plan.speechBoundaryHints || speechRegions;
    var decodeRegions = plan.decodeRegions || [];
    state.preprocessing.speechDetection = plan.source || detectionSource || "none";
    state.preprocessing.speechRegionCount = speechBoundaryHints.length;
    state.preprocessing.decodeRegionCount = decodeRegions.length;
    var recognitionAudioPath = activeAudioPath;
    if (state.preprocessing.speechIsolation && state.preprocessing.inputPath && fs.existsSync(state.preprocessing.inputPath)) {
      recognitionAudioPath = state.preprocessing.inputPath;
    }
    // Isolation is an explicit opt-in diagnostic/cleanup mode.  The normal
    // path preserves the original waveform and uses VAD only for boundaries.
    var isolationRequested = !!(job.preprocessing && (job.preprocessing.speechIsolation === true || job.preprocessing.isolateSpeech === true)) || !!(job.transcription && job.transcription.speechIsolation === true);
    if (isolationRequested && Array.isArray(decodeRegions) && decodeRegions.length && !state.preprocessing.speechIsolation) {
      var isolatedPath = store.path("speech-isolated.wav");
      try {
        if (speechIsolator.isolatePcm16MonoWav(activeAudioPath, isolatedPath, decodeRegions, { paddingMs: 0, mergeGapMs: 180 })) {
          recognitionAudioPath = isolatedPath;
          state.preprocessing.speechIsolation = true;
          state.preprocessing.inputPath = isolatedPath;
        }
      } catch (isolationError) {
        state.warnings.push(errors.warning(errors.ERROR_CODES.OUTPUT_INVALID, "璇煶鍒嗙闊抽鍒涘缓澶辫触锛屽皢浣跨敤鍘熷闊抽", { reason: isolationError.message }));
      }
    }
    var request = {
      cwd: store.directory,
      outputPrefix: store.path("whisper-output"),
      modelPath: model.path,
      audioPath: recognitionAudioPath,
      language: job.transcription.language || "auto",
      threads: job.transcription.threads || hardware.cpu && hardware.cpu.recommendedThreads || 1,
      device: deviceChoice.device,
      deviceIndex: deviceChoice.deviceIndex === undefined ? 0 : deviceChoice.deviceIndex,
      computeType: computeTypeFor(runtime, job, deviceChoice.device),
      allowHybrid: deviceChoice.hybrid === true,
      modelSizeBytes: model.sizeBytes || null,
      // A trusted external clip and whisper.cpp's internal VAD are mutually
      // exclusive; applying both gates can amplify false negatives.
      vad: runtime.engine === "whisper.cpp"
        ? !!self.options.whispercppVadModelPath
          && (!runtime.capabilities || runtime.capabilities.vad !== false)
          && !decodeRegions.length
        : true,
      vadModelPath: runtime.engine === "whisper.cpp" ? (self.options.whispercppVadModelPath || null) : (self.options.vadModelPath || null),
      vadOptions: {
        threshold: 0.50,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 350,
        maxSpeechDurationS: 28,
        speechPadMs: 240,
        samplesOverlap: 0.30
      },
      // Python engines decode each VAD island independently. Regions are relative
      // to the conformed WAV, so the adapter can add the original timeline offset.
      speechRegions: Array.isArray(speechRegions) ? speechRegions : [],
      speechBoundaryHints: Array.isArray(speechBoundaryHints) ? speechBoundaryHints : [],
      decodeRegions: Array.isArray(decodeRegions) ? decodeRegions : [],
      speechRegionPaddingMs: finiteNumber(job.transcription.speechRegionPaddingMs, 240),
      speechRegionMergeGapMs: finiteNumber(job.transcription.speechRegionMergeGapMs, 180),
      initialPrompt: typeof job.transcription.initialPrompt === "string" ? job.transcription.initialPrompt : null,
      hotwords: typeof job.transcription.hotwords === "string" ? job.transcription.hotwords : null,
      beamSize: finiteNumber(job.transcription.beamSize, 5),
      noSpeechThreshold: runtime.engine === "whisper.cpp" && !!self.options.whispercppVadModelPath && !decodeRegions.length ? 0.90 : 0.60,
      temperatureFallback: job.transcription.temperatureFallback !== false,
      speechRegionSource: plan.source || detectionSource || "none"
    };
    var adapterOptions = {
      cancelled: function () { return state.cancelled; },
      onProgress: function (percent) { self.emitProgress(job.jobId, "transcribing", percent); },
      onEvent: function (event) { self.emitProgress(job.jobId, event.phase || "transcribing", event.percent === undefined ? null : event.percent, event); }
    };
    state.controller = adapter.run(runtime, request, adapterOptions, function (runError, raw) {
      if (runError && runError.details && runError.details.oom && deviceChoice.device !== "cpu" && !fellBack) {
        state.gpuError = errors.serializeError(runError);
        state.warnings.push(errors.warning(errors.ERROR_CODES.GPU_OOM_FALLBACK_CPU, "显存不足，已切换 CPU"));
        self.emit("warning", state.warnings[state.warnings.length - 1]);
        cleanupAttemptFiles(store);
        return runWithDevice({ device: "cpu", reason: "oomFallback" }, true, activeAudioPath, null, null, plan);
      }
      if (runError && fellBack && state.gpuError) {
        return finish(errors.makeError(errors.ERROR_CODES.GPU_OOM_CPU_FAILED, "GPU 显存不足且 CPU 回退失败", { gpu: state.gpuError, cpu: errors.serializeError(runError) }));
      }
      if (runError) return finish(runError);
      self.emitProgress(job.jobId, "segmenting", 0);
      var segments;
      try {
        segments = segmentUtils.formatSegments(raw.segments || [], job.audioInput.timelineInMs, {
          pauseSoftMs: job.segmentation.pauseSoftMs,
          pauseHardMs: job.segmentation.pauseHardMs,
          maxCharsPerLine: job.segmentation.maxCharsPerLine,
          maxLines: job.segmentation.maxLines,
          maxRelativeMs: job.audioInput.timelineOutMs - job.audioInput.timelineInMs,
          speechRegions: speechRegions,
          speechBoundaryHints: speechBoundaryHints,
          speechEdgePaddingMs: 0
        });
        if (job.audioInput.reverse === true && typeof segmentUtils.mapCuesForReverse === "function") {
          segments = segmentUtils.mapCuesForReverse(
            segments,
            job.audioInput.timelineOutMs - job.audioInput.timelineInMs,
            job.audioInput.timelineInMs
          );
          segments = segments.map(function (segment, index) {
            var id = String(index + 1);
            while (id.length < 6) id = "0" + id;
            segment.id = "seg-" + id;
            return segment;
          });
        }
      } catch (segmentError) {
        return finish(errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "字幕断句失败", { reason: segmentError.message }));
      }
      self.emitProgress(job.jobId, "segmenting", 100, { segmentCount: segments.length });
      var result = {
        schemaVersion: 1,
        jobId: job.jobId,
        status: "completed",
        sourceLanguage: { code: raw.language || job.transcription.language || "auto", probability: raw.languageProbability || null },
        timeline: { inMs: job.audioInput.timelineInMs, outMs: job.audioInput.timelineOutMs },
        engine: { name: raw.engine && raw.engine.name || runtime.engine, version: raw.engine && raw.engine.version || runtime.version || null, device: deviceChoice.device, placement: raw.engine && raw.engine.placement || (deviceChoice.hybrid ? "hybrid" : deviceChoice.device), computeType: raw.engine && raw.engine.computeType || request.computeType || null, fellBackFromGpu: !!fellBack, preprocessing: state.preprocessing },
        segments: segments,
        warnings: state.warnings.slice(),
        artifacts: {}
      };
      runTranslation(result);
    });
  }

  function runTranslation(result) {
    var translation = job.translation;
    if (!translation.targetLanguages.length || translation.mode === "source") return saveResult(result);
    self.emitProgress(job.jobId, "translating", 0);
    resolveApiKey(self.options.getApiKey, translation.apiKeyRef, function (credentialError, apiKey) {
      if (credentialError) return finish(credentialError);
      if (state.cancelled) return finish(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
      var config = {};
      Object.keys(translation).forEach(function (key) { if (key !== "apiKey" && key !== "authorization") config[key] = translation[key]; });
      config.sourceLanguage = result.sourceLanguage.code;
      state.controller = translationClient.translateSegments(result.segments, config, apiKey, function (translationError) {
        apiKey = null;
        if (translationError) {
          if (translationError.code === errors.ERROR_CODES.JOB_CANCELED) return finish(translationError);
          result.status = "partialSuccess";
          result.warnings.push(errors.warning(errors.ERROR_CODES.TRANSLATION_PARTIAL, "部分或全部字幕翻译失败，已保留 STT 原文", {
            code: translationError.code,
            failedIds: translationError.details && translationError.details.failedIds || result.segments.map(function (segment) { return segment.id; })
          }));
          result.segments.forEach(function (segment) {
            segment.translations = segment.translations || {};
            translation.targetLanguages.forEach(function (target) {
              if (!segment.translations[target]) {
                segment.translations[target] = { text: segment.sourceText, lines: segment.sourceLines || [segment.sourceText], status: "failed", errorCode: translationError.code };
              }
            });
            segment.displayLanguages = translation.targetLanguages.slice();
          });
          self.emitProgress(job.jobId, "translating", null, { partial: true, code: translationError.code });
          return saveResult(result);
        }
        result.segments.forEach(function (segment) { segment.displayLanguages = translation.targetLanguages.slice(); });
        self.emitProgress(job.jobId, "translating", 100);
        saveResult(result);
      });
    });
  }

  function saveResult(result) {
    try {
      jobSchema.validateResult(result);
      result.artifacts.json = store.writeJsonAtomic("captions.json", result);
    } catch (saveError) { return finish(saveError); }
    finish(null, result);
  }

  function finish(error, result) {
    if (state.finished) return;
    state.finished = true;
    if (error && state.cancelled && error.code !== errors.ERROR_CODES.JOB_CANCELED) error = errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消");
    self.active = null;
    if (error) {
      if (!self.options.keepFailedJobs) store.cleanup();
      callback(error);
    } else callback(null, result);
  }

  return { cancel: function () { return self.cancel(); }, directory: store.directory };
};

module.exports = { TranscriptionRunner: TranscriptionRunner, resolveApiKey: resolveApiKey, cleanupAttemptFiles: cleanupAttemptFiles };
