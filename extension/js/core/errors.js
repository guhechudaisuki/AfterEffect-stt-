"use strict";

var ERROR_CODES = {
  INVALID_JSON: "E_INVALID_JSON",
  INVALID_REQUEST: "E_INVALID_REQUEST",
  UNKNOWN_METHOD: "E_UNKNOWN_METHOD",
  HOST_UNSUPPORTED: "E_HOST_UNSUPPORTED",
  VERSION_UNSUPPORTED: "E_VERSION_UNSUPPORTED",
  NO_PROJECT: "E_NO_PROJECT",
  FILE_NOT_FOUND: "E_FILE_NOT_FOUND",
  IO_DENIED: "E_IO_DENIED",
  SCAN_PATH_NOT_FOUND: "E_SCAN_PATH_NOT_FOUND",
  SCAN_PATH_INVALID: "E_SCAN_PATH_INVALID",
  SCAN_CANCELED: "E_SCAN_CANCELED",
  MODEL_UNSUPPORTED: "E_MODEL_UNSUPPORTED",
  MODEL_CORRUPT: "E_MODEL_CORRUPT",
  MODEL_UNTRUSTED_PT: "E_MODEL_UNTRUSTED_PT",
  RUNTIME_NOT_FOUND: "E_RUNTIME_NOT_FOUND",
  RUNTIME_PROBE_FAILED: "E_RUNTIME_PROBE_FAILED",
  RUNTIME_INCOMPATIBLE: "E_RUNTIME_INCOMPATIBLE",
  FFMPEG_NOT_FOUND: "E_FFMPEG_NOT_FOUND",
  AUDIO_INPUT_NOT_FOUND: "E_AUDIO_INPUT_NOT_FOUND",
  AUDIO_NO_STREAM: "E_AUDIO_NO_STREAM",
  AUDIO_NO_SIGNAL: "W_AUDIO_NO_SIGNAL",
  AUDIO_CONVERT_FAILED: "E_AUDIO_CONVERT_FAILED",
  UVR5_NOT_CONFIGURED: "E_UVR5_NOT_CONFIGURED",
  UVR5_FAILED: "E_UVR5_FAILED",
  DISK_SPACE: "E_DISK_SPACE",
  TEMP_PERMISSION: "E_TEMP_PERMISSION",
  PROCESS_SPAWN: "E_PROCESS_SPAWN",
  PROCESS_EXIT: "E_PROCESS_EXIT",
  PROCESS_TIMEOUT: "E_PROCESS_TIMEOUT",
  OUTPUT_INVALID: "E_OUTPUT_INVALID",
  GPU_UNAVAILABLE: "E_GPU_UNAVAILABLE",
  GPU_OOM_FALLBACK_CPU: "W_GPU_OOM_FALLBACK_CPU",
  GPU_OOM_CPU_FAILED: "E_GPU_OOM_CPU_FAILED",
  WORD_TIMESTAMPS_UNAVAILABLE: "W_WORD_TIMESTAMPS_UNAVAILABLE",
  VAD_UNAVAILABLE: "W_VAD_UNAVAILABLE",
  TIMING_ESTIMATED: "W_TIMING_ESTIMATED",
  SCAN_ACCESS_DENIED: "W_SCAN_ACCESS_DENIED",
  SCAN_LIMIT_REACHED: "W_SCAN_LIMIT_REACHED",
  TRANSLATION_PARTIAL: "W_TRANSLATION_PARTIAL",
  JOB_CANCELED: "E_JOB_CANCELED",
  TRANSLATION_ENDPOINT: "E_TRANSLATION_ENDPOINT",
  TRANSLATION_TLS: "E_TRANSLATION_TLS",
  TRANSLATION_AUTH: "E_TRANSLATION_AUTH",
  TRANSLATION_RATE_LIMIT: "E_TRANSLATION_RATE_LIMIT",
  TRANSLATION_HTTP: "E_TRANSLATION_HTTP",
  TRANSLATION_RESPONSE_INVALID: "E_TRANSLATION_RESPONSE_INVALID",
  TRANSLATION_TIMEOUT: "E_TRANSLATION_TIMEOUT",
  RESOURCE_INTEGRITY: "E_RESOURCE_INTEGRITY",
  RESOURCE_SIGNATURE: "E_RESOURCE_SIGNATURE"
};

function makeError(code, message, details, options) {
  options = options || {};
  var error = new Error(message || code);
  error.code = code;
  error.messageKey = options.messageKey || "error." + String(code).toLowerCase().replace(/^e_/, "");
  error.phase = options.phase || null;
  error.retryable = !!options.retryable;
  error.details = details || {};
  error.actions = options.actions || [];
  return error;
}

function serializeError(error) {
  if (!error) return null;
  return {
    code: error.code || "E_UNKNOWN",
    messageKey: error.messageKey || "error.unknown",
    phase: error.phase || null,
    retryable: !!error.retryable,
    details: redact(error.details || {}),
    actions: error.actions || [],
    message: redactText(error.message || String(error))
  };
}

function redactText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/("(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)"\s*:\s*")[^"]*/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[-_\s]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function redact(value) {
  var secret = /authorization|api[-_]?key|password|secret|token|cookie/i;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    value = redactText(value);
    return value.length > 500 ? value.slice(0, 500) + "..." : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  var out = {};
  Object.keys(value).forEach(function (key) {
    out[key] = secret.test(key) ? "[REDACTED]" : redact(value[key]);
  });
  return out;
}

function warning(code, message, details) {
  return { code: code, message: message || code, details: redact(details || {}) };
}

module.exports = {
  ERROR_CODES: ERROR_CODES,
  makeError: makeError,
  serializeError: serializeError,
  warning: warning,
  redact: redact,
  redactText: redactText
};
