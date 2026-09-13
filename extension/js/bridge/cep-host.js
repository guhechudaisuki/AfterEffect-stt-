"use strict";

function makeId() {
  return "req-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
}

function repairHostText(value) {
  var text = String(value === undefined || value === null ? "" : value);
  // ExtendScript/CEP versions in the field can expose UTF-8 bytes as Latin-1.
  // Only repair strings with the characteristic mojibake markers so normal
  // Latin-1 filenames and messages are left untouched.
  if (!/[ÃÂÆåæçèéä]/.test(text)) return text;
  var encoded = "";
  var index;
  var code;
  for (index = 0; index < text.length; index += 1) {
    code = text.charCodeAt(index);
    if (code > 255) return text;
    encoded += "%" + (code < 16 ? "0" : "") + code.toString(16);
  }
  try { return decodeURIComponent(encoded); } catch (ignore) { return text; }
}

function CepHostBridge(cep) {
  this.cep = cep || (typeof window !== "undefined" ? window.__adobe_cep__ : null);
}

CepHostBridge.prototype.call = function (route, params, callback) {
  if (!this.cep || typeof this.cep.evalScript !== "function") return callback(new Error("CEP host bridge is unavailable"));
  var request = { apiVersion: "1.0", requestId: makeId(), params: params || {} };
  var encoded = encodeURIComponent(JSON.stringify(request)).replace(/'/g, "%27");
  var script = "$._LWS.dispatch(" + JSON.stringify(route) + "," + JSON.stringify(encoded) + ")";

  function complete(responseText, allowDiagnostic) {
    if (!responseText || responseText === "EvalScript error.") {
      if (allowDiagnostic) {
        var diagnostic = "typeof $ !== 'undefined' && $._LWS && typeof $._LWS.dispatch === 'function' ? $._LWS.dispatch(\"common.bootstrapStatus\",\"\") : \"\"";
        return this.cep.evalScript(diagnostic, function (diagnosticText) { complete.call(this, diagnosticText, false); }.bind(this));
      }
      var evalError = new Error("ExtendScript evaluation failed. 请完全退出并重新打开 Adobe。");
      evalError.code = "CEP_EVALSCRIPT_FAILED";
      return callback(evalError);
    }
    var envelope;
    try { envelope = JSON.parse(responseText); } catch (error) { return callback(new Error("Invalid host response: " + String(responseText).slice(0, 200))); }
    if (!envelope.ok) {
      var hostError = new Error(repairHostText(envelope.error && envelope.error.message || "Host request failed"));
      hostError.code = envelope.error && envelope.error.code;
      hostError.details = envelope.error && envelope.error.details;
      return callback(hostError, null, envelope);
    }
    callback(null, envelope.data, envelope);
  }

  this.cep.evalScript(script, function (responseText) { complete.call(this, responseText, true); }.bind(this));
};

CepHostBridge.prototype.bootstrapFromExtensionRoot = function (extensionRoot, callback) {
  if (!this.cep || typeof this.cep.evalScript !== "function") return callback(new Error("CEP host bridge is unavailable"));
  var encodedRoot = encodeURIComponent(String(extensionRoot || ""));
  var script = "typeof $ !== 'undefined' && $._LWS && typeof $._LWS.bootstrapFromRoot === 'function' ? $._LWS.bootstrapFromRoot(" + JSON.stringify(encodedRoot) + ") : \"\"";
  this.cep.evalScript(script, function (responseText) {
    if (!responseText || responseText === "EvalScript error.") return callback(new Error("ExtendScript bootstrap failed"));
    var result;
    try { result = JSON.parse(responseText); } catch (error) { return callback(new Error("Invalid bootstrap response: " + String(responseText).slice(0, 200))); }
    if (!result.ok) {
      var bootstrapError = new Error(result.error && result.error.message || "Adobe host bootstrap incomplete");
      bootstrapError.code = result.error && result.error.code || "HOST_BOOTSTRAP_FAILED";
      bootstrapError.details = result.error && result.error.details;
      return callback(bootstrapError, result.data || null);
    }
    callback(null, result.data || null);
  });
};

CepHostBridge.prototype.getHostEnvironment = function () {
  if (!this.cep || !this.cep.getHostEnvironment) return null;
  try { return JSON.parse(this.cep.getHostEnvironment()); } catch (ignore) { return null; }
};

CepHostBridge.prototype.addEventListener = function (type, listener) {
  if (this.cep && this.cep.addEventListener) this.cep.addEventListener(type, listener);
};

module.exports = CepHostBridge;
