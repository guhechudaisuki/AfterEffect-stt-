"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var scanner = require("../extension/js/core/uvr5-model-scanner");

test("specified UVR5 scan finds GPT-SoVITS weights and its runtime", function (_, done) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "lws-uvr5-scan-"));
  var tool = path.join(root, "tools", "uvr5");
  var weights = path.join(tool, "uvr5_weights");
  var modelParams = path.join(tool, "lib", "lib_v5");
  var runtime = path.join(root, "runtime");
  fs.mkdirSync(weights, { recursive: true });
  fs.mkdirSync(modelParams, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(tool, "vr.py"), "class AudioPre: pass\n");
  fs.writeFileSync(path.join(modelParams, "model_param_init.py"), "class ModelParameters: pass\n");
  fs.writeFileSync(path.join(weights, "HP2_all_vocals.pth"), "model");
  fs.writeFileSync(path.join(runtime, "python.exe"), "python");
  scanner.inspectSpecified(root, {}, function (error, result) {
    try {
      assert.ifError(error);
      assert.equal(result.models.length, 1);
      assert.equal(result.models[0].displayName, "HP2_all_vocals");
      assert.equal(result.models[0].pythonExecutable, path.join(runtime, "python.exe"));
      assert.equal(result.models[0].compatible, true);
      done();
    } catch (failure) { done(failure); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
