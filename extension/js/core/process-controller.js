"use strict";

var cp = require("child_process");
var errors = require("./errors");

var SECRET_ENV = /(?:^|_)(?:API_?KEY|AUTHORIZATION|PASSWORD|SECRET|ACCESS_?TOKEN|REFRESH_?TOKEN|TOKEN|COOKIE)(?:$|_)/i;

function sanitizeEnvironment(source) {
  var input = source || process.env;
  var output = {};
  Object.keys(input).forEach(function (key) {
    if (/^PYTHON(?:PATH|HOME)$/i.test(key) || SECRET_ENV.test(key)) return;
    output[key] = input[key];
  });
  return output;
}

function spawnProcess(command, args, options, callback) {
  options = options || {};
  args = Array.isArray(args) ? args.slice() : [];
  var spawn = options.spawn || cp.spawn;
  var child;
  var callbackCalled = false;
  var cancelRequested = false;
  var timer = null;

  function finish(error, result) {
    if (callbackCalled) return;
    callbackCalled = true;
    if (timer) clearTimeout(timer);
    callback(error, result);
  }

  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: sanitizeEnvironment(options.env),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    finish(errors.makeError(errors.ERROR_CODES.PROCESS_SPAWN, "无法启动本地进程", { command: command, reason: errors.redactText(error.message) }));
    return null;
  }
  if (!child || typeof child.on !== "function") {
    finish(errors.makeError(errors.ERROR_CODES.PROCESS_SPAWN, "本地进程对象无效", { command: command }));
    return null;
  }

  var stdout = "";
  var stderr = "";
  var maxOutput = options.maxOutputBytes || 1024 * 1024;
  function append(current, chunk) {
    current += errors.redactText(String(chunk || ""));
    return current.length > maxOutput ? current.slice(current.length - maxOutput) : current;
  }
  if (child.stdout && child.stdout.on) child.stdout.on("data", function (chunk) {
    var text = errors.redactText(String(chunk));
    stdout = append(stdout, text);
    if (options.onStdout) { try { options.onStdout(text); } catch (ignore) {} }
  });
  if (child.stderr && child.stderr.on) child.stderr.on("data", function (chunk) {
    var text = errors.redactText(String(chunk));
    stderr = append(stderr, text);
    if (options.onStderr) { try { options.onStderr(text); } catch (ignore) {} }
  });
  var timedOut = false;
  if (options.timeoutMs) {
    timer = setTimeout(function () {
      timedOut = true;
      terminate(child, options.killGraceMs || 1000);
    }, options.timeoutMs);
    if (timer.unref) timer.unref();
  }
  child.on("error", function (error) {
    if (cancelRequested || options.cancelled && options.cancelled()) {
      return finish(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
    }
    finish(errors.makeError(errors.ERROR_CODES.PROCESS_SPAWN, "本地进程启动失败", { command: command, reason: errors.redactText(error.message) }));
  });
  child.on("close", function (code, signal) {
    if (timedOut) return finish(errors.makeError(errors.ERROR_CODES.PROCESS_TIMEOUT, "本地进程超时", { command: command, timeoutMs: options.timeoutMs }));
    if (cancelRequested || options.cancelled && options.cancelled()) return finish(errors.makeError(errors.ERROR_CODES.JOB_CANCELED, "任务已取消"));
    var result = { code: code, signal: signal, stdout: stdout, stderr: stderr, pid: child.pid };
    if (code !== 0) return finish(errors.makeError(errors.ERROR_CODES.PROCESS_EXIT, "本地进程退出码非零", { command: command, code: code, stderr: stderr.slice(-1000) }));
    finish(null, result);
  });
  return {
    pid: child.pid,
    child: child,
    cancel: function () {
      cancelRequested = true;
      terminate(child, options.killGraceMs || 1000);
    }
  };
}

function terminate(child, graceMs) {
  if (!child || child.killed) return;
  try { child.kill(); } catch (ignore) {}
  if (process.platform !== "win32") return;
  var timer = setTimeout(function () {
    if (child.exitCode !== null || child.signalCode) return;
    try {
      cp.spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", env: sanitizeEnvironment() });
    } catch (ignore) {}
  }, graceMs || 1000);
  if (timer.unref) timer.unref();
}

function spawnSync(command, args, options) {
  options = options || {};
  var spawn = options.spawnSync || cp.spawnSync;
  try {
    var result = spawn(command, Array.isArray(args) ? args.slice() : [], { shell: false, windowsHide: true, timeout: options.timeoutMs || 5000, cwd: options.cwd, env: sanitizeEnvironment(options.env), encoding: "utf8" });
    return { code: result.status, stdout: errors.redactText(result.stdout || ""), stderr: errors.redactText(result.stderr || ""), error: result.error || null };
  } catch (error) {
    return { code: -1, stdout: "", stderr: errors.redactText(error.message), error: error };
  }
}

module.exports = { spawnProcess: spawnProcess, spawnSync: spawnSync, terminate: terminate, sanitizeEnvironment: sanitizeEnvironment };
