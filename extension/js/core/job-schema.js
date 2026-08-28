"use strict";

var errors = require("./errors");

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, name + " must be a non-empty string", { field: name });
  }
}

function requireNumber(value, name) {
  if (typeof value !== "number" || !isFinite(value)) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, name + " must be a finite number", { field: name });
  }
}

function isInteger(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function containsCredentialField(value) {
  var secretKey = /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)$/i;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialField);
  return Object.keys(value).some(function (key) {
    return secretKey.test(key) || containsCredentialField(value[key]);
  });
}

function validateJob(job) {
  if (!isObject(job)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "Job must be an object");
  requireString(job.jobId, "jobId");
  if (!isObject(job.audioInput)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "audioInput is required");
  requireString(job.audioInput.path, "audioInput.path");
  requireNumber(job.audioInput.timelineInMs, "audioInput.timelineInMs");
  requireNumber(job.audioInput.timelineOutMs, "audioInput.timelineOutMs");
  if (job.audioInput.timelineInMs < 0) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "audioInput.timelineInMs must be >= 0");
  if (job.audioInput.timelineOutMs > 864000000) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "audioInput.timelineOutMs is unreasonably large");
  if (job.audioInput.timelineOutMs <= job.audioInput.timelineInMs) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "audio range must be positive");
  }
  if (job.audioInput.playbackRate !== undefined && (typeof job.audioInput.playbackRate !== "number" || !isFinite(job.audioInput.playbackRate) || job.audioInput.playbackRate <= 0)) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "audioInput.playbackRate must be a positive number");
  }
  if (job.preprocessing !== undefined && !isObject(job.preprocessing)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "preprocessing must be an object");
  if (job.preprocessing && job.preprocessing.uvr5Enabled) {
    if (!isObject(job.preprocessing.uvr5Model)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "preprocessing.uvr5Model is required");
    requireString(job.preprocessing.uvr5Model.path, "preprocessing.uvr5Model.path");
    requireString(job.preprocessing.uvr5Model.uvrRoot, "preprocessing.uvr5Model.uvrRoot");
    requireString(job.preprocessing.uvr5Model.pythonExecutable, "preprocessing.uvr5Model.pythonExecutable");
  }
  if (!isObject(job.model)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "model is required");
  requireString(job.model.path, "model.path");
  requireString(job.model.format, "model.format");
  if (["openai-pt", "ggml-bin", "gguf", "ctranslate2", "huggingface-whisper"].indexOf(job.model.format) < 0) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "unsupported model format", { format: job.model.format });
  }
  if (!isObject(job.transcription)) job.transcription = {};
  if (["auto", "cpu", "cuda", "gpu", "hybrid"].indexOf(job.transcription.devicePolicy || "auto") < 0) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "invalid devicePolicy");
  }
  if (job.transcription.wordTimestamps === false || job.transcription.vad === false) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "word timestamps and VAD are required");
  }
  job.transcription.wordTimestamps = true;
  job.transcription.vad = true;
  if (job.segmentation === undefined) job.segmentation = {};
  if (!isObject(job.segmentation)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "segmentation must be an object");
  if (job.segmentation.maxCharsPerLine === undefined) job.segmentation.maxCharsPerLine = 0;
  if (job.segmentation.mode !== undefined && job.segmentation.mode !== "smart") {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "smart sentence segmentation cannot be disabled");
  }
  job.segmentation.mode = "smart";
  if (!isInteger(job.segmentation.maxCharsPerLine) || job.segmentation.maxCharsPerLine < 0) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "maxCharsPerLine must be an integer >= 0");
  }
  if (job.segmentation.maxLines !== null && job.segmentation.maxLines !== undefined &&
      (!isInteger(job.segmentation.maxLines) || job.segmentation.maxLines < 1)) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "maxLines must be null or an integer >= 1");
  }
  if (job.translation === undefined) job.translation = { mode: "source", targetLanguages: [] };
  if (!isObject(job.translation)) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "translation must be an object");
  if (containsCredentialField(job.translation)) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "plaintext translation credentials are forbidden in job JSON", { field: "translation.apiKey" });
  }
  if (!Array.isArray(job.translation.targetLanguages)) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "translation.targetLanguages must be an array");
  }
  if (job.translation.targetLanguages.length > 2) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "at most two target languages are supported");
  }
  var seenLanguages = {};
  job.translation.targetLanguages.forEach(function (language) {
    requireString(language, "translation.targetLanguages[]");
    var normalized = language.toLowerCase();
    if (seenLanguages[normalized]) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "translation target languages must be distinct");
    seenLanguages[normalized] = true;
  });
  var mode = job.translation.mode || (job.translation.targetLanguages.length === 2 ? "bilingual" : job.translation.targetLanguages.length === 1 ? "single" : "source");
  if (["source", "single", "bilingual"].indexOf(mode) < 0) throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "invalid translation mode");
  if (mode === "source" && job.translation.targetLanguages.length !== 0 || mode === "single" && job.translation.targetLanguages.length !== 1 || mode === "bilingual" && job.translation.targetLanguages.length !== 2) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "translation mode does not match target language count");
  }
  if (job.translation.apiKeyRef !== undefined && job.translation.apiKeyRef !== null && (typeof job.translation.apiKeyRef !== "string" || !job.translation.apiKeyRef.trim())) {
    throw errors.makeError(errors.ERROR_CODES.INVALID_REQUEST, "translation.apiKeyRef must be a non-empty string");
  }
  job.translation.mode = mode;
  return job;
}

function validateResult(result) {
  if (!isObject(result) || typeof result.jobId !== "string" || !Array.isArray(result.segments)) {
    throw errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "invalid transcription result envelope");
  }
  var previousStart = -1;
  var previousEnd = -1;
  var timeline = result.timeline;
  var duration = timeline && typeof timeline.inMs === "number" && typeof timeline.outMs === "number" ? timeline.outMs - timeline.inMs : null;
  result.segments.forEach(function (segment, index) {
    if (!isObject(segment) || typeof segment.id !== "string") {
      throw errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "invalid segment", { index: index });
    }
    requireNumber(segment.startMs, "segments[" + index + "].startMs");
    requireNumber(segment.endMs, "segments[" + index + "].endMs");
    if (segment.endMs < segment.startMs || segment.startMs < previousStart || segment.startMs < previousEnd) {
      throw errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "segment times are not monotonic", { index: index });
    }
    if (duration !== null && typeof segment.relativeStartMs === "number" && typeof segment.relativeEndMs === "number") {
      if (segment.relativeStartMs < 0 || segment.relativeEndMs < segment.relativeStartMs || segment.relativeEndMs > duration || segment.startMs !== timeline.inMs + segment.relativeStartMs || segment.endMs !== timeline.inMs + segment.relativeEndMs) {
        throw errors.makeError(errors.ERROR_CODES.OUTPUT_INVALID, "segment timing is outside the requested range", { index: index });
      }
    }
    previousStart = segment.startMs;
    previousEnd = segment.endMs;
  });
  return result;
}

function makeEnvelope(requestId, host, hostVersion, data, error, warnings, startedAt) {
  return {
    apiVersion: "1.0",
    requestId: requestId || "",
    ok: !error,
    data: error ? null : data,
    warnings: warnings || [],
    error: error ? errors.serializeError(error) : null,
    meta: { host: host || null, hostVersion: hostVersion || null, elapsedMs: startedAt ? Date.now() - startedAt : null }
  };
}

module.exports = {
  validateJob: validateJob,
  validateResult: validateResult,
  makeEnvelope: makeEnvelope
};
