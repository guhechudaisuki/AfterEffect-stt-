(function () {
  "use strict";

  function queryValue(name) {
    var match = new RegExp("(?:^|[?&])" + name + "=([^&]*)").exec(window.location.search || "");
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
  }

  function initializeMock(host) {
    host = String(host || "AEFT").toUpperCase() === "PPRO" ? "PPRO" : "AEFT";
    var shell = document.querySelector(".panel-shell");
    shell.dataset.host = host;
    document.documentElement.classList.add("mock-preview");
    document.getElementById("hostBadge").textContent = host === "AEFT" ? "AE" : "PR";
    document.getElementById("hostLabel").textContent = host === "AEFT" ? "After Effects 2020+" : "Premiere Pro 2020+";
    Array.prototype.forEach.call(document.querySelectorAll(".ae-only"), function (element) { element.hidden = host !== "AEFT"; });
    Array.prototype.forEach.call(document.querySelectorAll(".pr-only"), function (element) { element.hidden = host !== "PPRO"; });
    document.getElementById("aeOutputModes").hidden = host !== "AEFT";
    document.getElementById("contextName").textContent = host === "AEFT" ? "主合成 · 第 03 场" : "Episode_03_Master";
    document.getElementById("contextMeta").textContent = host === "AEFT" ? "3840 × 2160 · Work Area" : "3840 × 2160 · Sequence In/Out";
    document.getElementById("rangeIn").textContent = "00:01:12.400";
    document.getElementById("rangeOut").textContent = "00:01:39.600";
    document.getElementById("rangeDuration").textContent = "00:00:27.200";
    document.getElementById("systemStatus").dataset.tone = "ready";
    document.getElementById("statusTitle").textContent = "本地模型可用";
    document.getElementById("statusDetail").textContent = "large-v3-turbo Q5_0 · CUDA 自动调度";
    var model = document.getElementById("modelSelect");
    model.disabled = false;
    model.innerHTML = "";
    var option = document.createElement("option");
    option.textContent = "large-v3-turbo Q5_0 · GGML";
    model.appendChild(option);
    document.getElementById("runtimeLine").dataset.ready = "true";
    document.getElementById("runtimeName").textContent = "whisper.cpp";
    document.getElementById("runtimeDetail").textContent = "CUDA / CPU";
    document.getElementById("runButton").disabled = false;
    document.getElementById("runStatus").textContent = "可以生成字幕";
    var mockUvr5 = document.getElementById("uvr5ModelSelect");
    mockUvr5.disabled = false;
    mockUvr5.innerHTML = "<option>HP2_all_vocals</option>";
    document.getElementById("enableUvr5Input").disabled = false;
    document.getElementById("uvr5Row").dataset.ready = "true";
    document.getElementById("uvr5PathLabel").textContent = "X:\\models\\uvr5\\HP2_all_vocals.pth";
    if (host === "PPRO") document.getElementById("prCaptionOutputDetail").textContent = "自动创建原生字幕轨";
    Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (button) {
      button.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (item) { item.setAttribute("aria-selected", item === button ? "true" : "false"); });
        Array.prototype.forEach.call(document.querySelectorAll("[data-panel]"), function (panel) { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-translation-mode]"), function (button) {
      button.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll("[data-translation-mode]"), function (item) { item.classList.toggle("active", item === button); });
        document.getElementById("translationFields").hidden = button.dataset.translationMode === "source";
        document.getElementById("targetLanguageBField").hidden = button.dataset.translationMode !== "bilingual";
      });
    });
    if (queryValue("view") === "templates" && host === "AEFT") document.getElementById("templateDetails").open = true;
    if (queryValue("view") === "effects" && host === "AEFT") document.getElementById("effectCopyDetails").open = true;
    if (window.lucide) window.lucide.createIcons();
  }

  var mockHost = queryValue("mock");
  if (mockHost) {
    initializeMock(mockHost);
    installAdaptiveGrid();
    return;
  }

  if (!window.__adobe_cep__) {
    document.getElementById("systemStatus").dataset.tone = "error";
    document.getElementById("statusTitle").textContent = "Adobe CEP 不可用";
    document.getElementById("statusDetail").textContent = "请从 Adobe After Effects 或 Premiere Pro 2020+ 打开此面板";
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  var cep = window.__adobe_cep__;
  var nodeRequire = window.cep_node && window.cep_node.require ? window.cep_node.require : (window.require || require);
  var fs = nodeRequire("fs");
  var path = nodeRequire("path");
  var os = nodeRequire("os");

  function extensionPath() {
    var value = cep.getSystemPath("extension");
    try { value = decodeURIComponent(value); } catch (ignore) {}
    return value.replace(/^file:\/\//i, "").replace(/^\/(?:[A-Za-z]:)/, function (match) { return match.slice(1); }).replace(/\//g, path.sep);
  }

  var root = extensionPath();
  var CepHostBridge = nodeRequire(path.join(root, "js", "bridge", "cep-host.js"));
  var SelectionRecorder = nodeRequire(path.join(root, "js", "features", "ae-selection-recorder.js"));
  var windowsFonts = nodeRequire(path.join(root, "js", "features", "windows-fonts.js"));
  var PropertyTree = nodeRequire(path.join(root, "js", "ui", "property-tree.js"));
  var modelScanner = nodeRequire(path.join(root, "js", "core", "model-scanner.js"));
  var uvr5ModelScanner = nodeRequire(path.join(root, "js", "core", "uvr5-model-scanner.js"));
  var runtimeDetector = nodeRequire(path.join(root, "js", "core", "runtime-detector.js"));
  var matcher = nodeRequire(path.join(root, "js", "core", "model-runtime-matcher.js"));
  var hardwareProfiler = nodeRequire(path.join(root, "js", "core", "hardware-profiler.js"));
  var Runner = nodeRequire(path.join(root, "js", "core", "transcription-runner.js")).TranscriptionRunner;
  var srt = nodeRequire(path.join(root, "js", "core", "srt.js"));
  var translationClient = nodeRequire(path.join(root, "js", "core", "translation-client.js"));
  var tempStore = nodeRequire(path.join(root, "js", "core", "temp-job-store.js"));
  var bridge = new CepHostBridge(cep);

  var state = {
    host: "unknown",
    capabilities: {},
    context: null,
    range: null,
    models: [],
    runtimes: [],
    pythonPaths: [],
    ffmpeg: null,
    selectedModel: null,
    translationMode: "source",
    outputMode: null,
    currentRunner: null,
    encoderJobs: {},
    templateModules: {},
    effectModules: {},
    aepPicker: null,
    sessionApiKeys: {},
    busy: false,
    runStartedAt: 0,
    runTimer: null,
    runProgressContext: "",
    activeDevice: null,
    activePlacement: null,
    effectTreeLoading: false,
    scanMode: null,
    scanPath: null,
    installedModelPath: null,
    uvr5Models: [],
    selectedUvr5Model: null,
    uvr5ScanMode: null,
    uvr5ScanPath: null,
    compTemplate: null,
    compTemplateCandidates: [],
    settings: null
  };

  function byId(id) { return document.getElementById(id); }
  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function numberValue(id, fallback) { var value = Number(byId(id).value); return isFinite(value) ? value : fallback; }
  function setText(id, text) { var element = byId(id); if (element) element.textContent = text; }

  function setStatus(tone, title, detail) {
    var status = byId("systemStatus");
    status.dataset.tone = tone;
    setText("statusTitle", title);
    setText("statusDetail", detail || "");
  }

  function showDialog(title, message, confirmText, onConfirm) {
    var dialog = byId("messageDialog");
    setText("dialogTitle", title);
    setText("dialogMessage", message);
    var button = byId("dialogConfirmButton");
    button.textContent = confirmText || "确认";
    button.hidden = !onConfirm;
    dialog._onConfirm = onConfirm || null;
    if (dialog.showModal) dialog.showModal(); else window.alert(title + "\n\n" + message);
  }

  function formatClock(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor(seconds % 3600 / 60);
    var s = Math.floor(seconds % 60);
    var ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
    function pad(value, width) { var text = String(value); while (text.length < width) text = "0" + text; return text; }
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(ms, 3);
  }

  function hostCall(route, params) {
    return new Promise(function (resolve, reject) { bridge.call(route, params || {}, function (error, data, envelope) { if (error) reject(error); else resolve({ data: data, envelope: envelope }); }); });
  }

  function detectHostFromEnvironment() {
    var environment = bridge.getHostEnvironment ? bridge.getHostEnvironment() : null;
    var values = [];
    var value;
    var i;
    if (!environment) return null;
    values.push(environment.appId, environment.appName, environment.hostName, environment.host);
    for (i = 0; i < values.length; i += 1) {
      value = String(values[i] || "").toUpperCase();
      if (value.indexOf("AEFT") >= 0 || value.indexOf("AFTEREFFECTS") >= 0 || value.indexOf("AFTER EFFECTS") >= 0) return "AEFT";
      if (value.indexOf("PPRO") >= 0 || value.indexOf("PREMIERE") >= 0) return "PPRO";
    }
    return null;
  }

  function hostErrorDetail(error) {
    var detail = error && error.message ? error.message : "宿主脚本连接失败";
    var diagnostics = error && error.details;
    var firstError;
    if (error && error.code) detail += " · " + error.code;
    if (diagnostics && diagnostics.errors && diagnostics.errors.length) {
      firstError = diagnostics.errors[0];
      detail += " · " + (firstError.stage || "bootstrap") + ": " + (firstError.error || "unknown error");
      if (firstError.path) detail += " · " + firstError.path;
    }
    return detail;
  }

  function choosePath(directory, title, extensions) {
    var result = window.cep.fs.showOpenDialog(false, !!directory, title || "选择路径", "", extensions || []);
    if (!result || result.err || !result.data || !result.data.length) return null;
    return result.data[0];
  }

  function populateLanguages() {
    var languages = [
      ["zh-CN", "中文"], ["en-US", "English"], ["ja-JP", "日本語"], ["ko-KR", "한국어"],
      ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["es-ES", "Español"], ["pt-BR", "Português"],
      ["ru-RU", "Русский"], ["ar", "العربية"], ["it-IT", "Italiano"], ["th-TH", "ไทย"]
    ];
    ["targetLanguageA", "targetLanguageB"].forEach(function (id, selectIndex) {
      var select = byId(id);
      select.innerHTML = "";
      languages.forEach(function (language, index) {
        var option = document.createElement("option");
        option.value = language[0];
        option.textContent = language[1];
        if (index === selectIndex) option.selected = true;
        select.appendChild(option);
      });
    });
  }

  function setHostUi(host) {
    state.host = host;
    document.querySelector(".panel-shell").dataset.host = host;
    setText("hostBadge", host === "AEFT" ? "AE" : (host === "PPRO" ? "PR" : "--"));
    all(".ae-only").forEach(function (element) { element.hidden = host !== "AEFT"; });
    all(".pr-only").forEach(function (element) { element.hidden = host !== "PPRO"; });
    byId("aeOutputModes").hidden = host !== "AEFT";
    state.outputMode = host === "AEFT" ? "perSegmentLayers" : "captions";
    if (!state.settings || state.settings.sttEnabled === undefined) byId("enableSttInput").checked = host === "PPRO";
    updateSttVisibility();
  }

  function applyCapabilities() {
    if (state.host !== "PPRO") return;
    if (state.capabilities.captionImport === false) {
      state.outputMode = null;
      setText("prCaptionOutputDetail", "当前版本不能导入 SRT 字幕");
      setStatus("error", "Premiere 字幕接口不可用", "当前 Premiere Pro 无法导入 SRT 字幕素材");
      return;
    }
    state.outputMode = "captions";
    setText("prCaptionOutputDetail", state.capabilities.nativeCaptions ? "自动创建原生字幕轨" : "生成并导入 SRT，需手动拖入时间轴");
  }

  function loadContext() {
    var contextRoute = state.host === "AEFT" ? "ae.context.get" : "pr.context.get";
    var rangeRoute = state.host === "AEFT" ? "ae.range.get" : "pr.range.get";
    return Promise.all([hostCall(contextRoute), hostCall(rangeRoute)]).then(function (results) {
      state.context = results[0].data;
      state.range = results[1].data;
      if (state.host === "AEFT") {
        var comp = state.context.activeComp;
        setText("contextName", comp.name);
        setText("contextMeta", comp.width + " × " + comp.height + " · Work Area");
        setText("rangeIn", formatClock(state.range.start));
        setText("rangeOut", formatClock(state.range.end));
        setText("rangeDuration", formatClock(state.range.duration));
      } else {
        var seq = state.context.activeSequence;
        setText("contextName", seq.name);
        setText("contextMeta", seq.frameSizeHorizontal + " × " + seq.frameSizeVertical + " · Sequence In/Out");
        setText("rangeIn", formatClock(state.range.start.seconds));
        setText("rangeOut", formatClock(state.range.end.seconds));
        setText("rangeDuration", formatClock(state.range.durationSeconds));
      }
      updateReadyState();
    }).catch(function (error) {
      state.context = null;
      state.range = null;
      setStatus("error", "无法读取入点到出点", error.message + (error.code ? " · " + error.code : ""));
      updateReadyState();
    });
  }

  function loadFonts() {
    if (state.host !== "AEFT") {
      return new Promise(function (resolve) {
        windowsFonts.scan(function (error, result) {
          var fonts = !error && result && result.fonts && result.fonts.length ? result.fonts : [
            { postScriptName: "Arial", familyName: "Arial" },
            { postScriptName: "Microsoft YaHei UI", familyName: "Microsoft YaHei UI" },
            { postScriptName: "Segoe UI", familyName: "Segoe UI" }
          ];
          var list = byId("fontList");
          list.innerHTML = "";
          fonts.forEach(function (font) { addFontOption(font.postScriptName, font.familyName); });
          resolve();
        });
      });
    }
    return hostCall("ae.fonts.list").then(function (result) {
      var list = byId("fontList");
      list.innerHTML = "";
      (result.data.fonts || []).forEach(function (font) { addFontOption(font.postScriptName, font.familyName + " " + font.styleName); });
    }).catch(function () {});
  }

  function addFontOption(value, label) {
    var option = document.createElement("option");
    option.value = value;
    option.label = label || value;
    byId("fontList").appendChild(option);
  }

  function detectEnvironment(models, callback) {
    var managedRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), "LocalWhisperSubtitles");
    var roots = [path.join(managedRoot, "runtime"), path.join(root, "..", "resources", "runtimes")];
    (models || []).forEach(function (model) { roots.push(model.path); });
    runtimeDetector.detectRuntimes({ extraRoots: roots, pythonPaths: state.pythonPaths }, function (error, result) {
      if (error) return callback(error);
      state.runtimes = result.runtimes || [];
      state.ffmpeg = result.ffmpeg;
      state.models = matcher.annotateModels(models || [], state.runtimes, hardwareProfiler.profile());
      state.runtimes.forEach(function (runtime) {
        if (runtime.engine !== "whisper.cpp") runtime.bridgePath = path.join(root, "python", "whisper_bridge.py");
      });
      callback(null);
    });
  }

  function loadConfiguredPythonRuntime() {
    var stateFile = path.join(process.env.LOCALAPPDATA || os.homedir(), "LocalWhisperSubtitles", "install-state.json");
    try {
      var installed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      var python = installed && installed.pythonExecutablePath;
      if (python && fs.existsSync(python)) {
        state.pythonPaths = [python];
        setText("pythonRuntimePath", python);
      }
      var installedModelPath = installed && installed.modelPath;
      if (installedModelPath && fs.existsSync(installedModelPath)) state.installedModelPath = installedModelPath;
      return installed;
    } catch (ignore) {}
    return null;
  }

  function settingsFilePath() {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "LocalWhisperSubtitles", "setting.txt");
  }

  function settingsSnapshot() {
    return {
      schemaVersion: 1,
      scanMode: state.scanMode,
      scanPath: state.scanPath,
      models: (state.models || []).map(function (model) { return model; }),
      selectedModelId: state.selectedModel && state.selectedModel.id || null,
      sttEnabled: byId("enableSttInput").checked,
      uvr5Enabled: byId("enableUvr5Input").checked && !byId("enableUvr5Input").disabled,
      uvr5ScanMode: state.uvr5ScanMode,
      uvr5ScanPath: state.uvr5ScanPath,
      uvr5Models: state.uvr5Models,
      selectedUvr5ModelId: state.selectedUvr5Model && state.selectedUvr5Model.id || null,
      pythonExecutablePath: state.pythonPaths[0] || null,
      devicePolicy: byId("deviceSelect").value,
      language: byId("languageSelect").value,
      translationMode: state.translationMode,
      outputMode: state.outputMode,
      style: styleSettings(),
      wrapping: { maxCharsPerLine: numberValue("maxLineCharsInput", 0), maxLines: numberValue("maxLinesInput", 2) },
      translation: { baseUrl: byId("apiBaseUrl").value, model: byId("translationModel").value,
        targetLanguageA: byId("targetLanguageA").value, targetLanguageB: byId("targetLanguageB").value }
    };
  }

  function saveSettings() {
    try {
      var file = settingsFilePath();
      var snapshot = settingsSnapshot();
      tempStore.ensureDirectory(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
      state.settings = snapshot;
    } catch (ignore) {}
  }

  function loadSettings() {
    try {
      var value = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"));
      if (!value || value.schemaVersion !== 1) return null;
      state.settings = value;
      state.scanMode = value.scanMode || null;
      state.scanPath = value.scanPath || null;
      if (value.pythonExecutablePath && fs.existsSync(value.pythonExecutablePath)) {
        state.pythonPaths = [value.pythonExecutablePath];
        setText("pythonRuntimePath", value.pythonExecutablePath);
      }
      if (value.devicePolicy) byId("deviceSelect").value = value.devicePolicy;
      if (value.language) byId("languageSelect").value = value.language;
      if (value.sttEnabled !== undefined) byId("enableSttInput").checked = value.sttEnabled !== false;
      state.uvr5ScanMode = value.uvr5ScanMode || null;
      state.uvr5ScanPath = value.uvr5ScanPath || null;
      state.uvr5Models = value.uvr5Models || [];
      if (value.translationMode) state.translationMode = value.translationMode;
      if (value.outputMode) state.outputMode = value.outputMode;
      if (value.style) {
        if (value.style.font) byId("fontInput").value = value.style.font;
        if (value.style.fontSize !== undefined) byId("fontSizeInput").value = value.style.fontSize;
        if (value.style.tracking !== undefined) byId("trackingInput").value = value.style.tracking;
        if (value.style.leading !== undefined) byId("leadingInput").value = value.style.leading;
        if (value.style.center) {
          if (value.style.center.x !== undefined) byId("positionX").value = value.style.center.x;
          if (value.style.center.y !== undefined) byId("positionY").value = value.style.center.y;
        }
      }
      if (value.wrapping) {
        if (value.wrapping.maxCharsPerLine !== undefined) byId("maxLineCharsInput").value = value.wrapping.maxCharsPerLine;
        if (value.wrapping.maxLines !== undefined) byId("maxLinesInput").value = value.wrapping.maxLines;
        byId("maxLinesInput").disabled = Number(byId("maxLineCharsInput").value) === 0;
      }
      if (value.translation) {
        if (value.translation.baseUrl) byId("apiBaseUrl").value = value.translation.baseUrl;
        if (value.translation.model) byId("translationModel").value = value.translation.model;
        if (value.translation.targetLanguageA) byId("targetLanguageA").value = value.translation.targetLanguageA;
        if (value.translation.targetLanguageB) byId("targetLanguageB").value = value.translation.targetLanguageB;
      }
      if (value.scanPath) setText("scanPathLabel", value.scanPath);
      if (value.uvr5ScanPath) setText("uvr5PathLabel", value.uvr5ScanPath);
      renderUvr5Models(value.selectedUvr5ModelId, value.uvr5Enabled === true);
      updateSttVisibility();
      return value;
    } catch (ignore) { return null; }
  }

  function renderModels() {
    var select = byId("modelSelect");
    select.innerHTML = "";
    state.models.forEach(function (model, index) {
      var option = document.createElement("option");
      option.value = String(index);
      option.textContent = model.displayName + " · " + model.format + (model.compatible ? "" : " · 缺少运行环境");
      option.disabled = !model.compatible;
      select.appendChild(option);
    });
    var readyIndex = state.models.findIndex(function (model) { return model.compatible && state.settings && model.id === state.settings.selectedModelId; });
    if (readyIndex < 0) readyIndex = state.models.findIndex(function (model) { return model.compatible; });
    select.disabled = readyIndex < 0;
    if (readyIndex >= 0) {
      select.value = String(readyIndex);
      state.selectedModel = state.models[readyIndex];
      renderRuntime();
      byId("recommendedModel").hidden = true;
      setStatus("ready", "本地模型可用", state.selectedModel.displayName);
      saveSettings();
    } else {
      state.selectedModel = null;
      byId("recommendedModel").hidden = false;
      var found = state.models.length;
      if (found) setStatus("warning", "找到模型，但缺少兼容运行环境", state.models[0].displayName + " · " + state.models[0].format);
      else setStatus("warning", "本机未发现 Whisper 模型", "可指定本地模型或获取默认推荐模型");
      renderRuntime();
    }
    updateReadyState();
  }

  function renderRuntime() {
    var line = byId("runtimeLine");
    var runtime = selectedRuntime();
    line.dataset.ready = runtime ? "true" : "false";
    setText("runtimeName", runtime ? runtime.engine : "没有匹配的运行环境");
    setText("runtimeDetail", runtime ? (runtime.devices || ["cpu"]).join(" / ") : "");
    var gpuOption = byId("deviceSelect").querySelector('option[value="gpu"]');
    if (gpuOption) {
      gpuOption.disabled = !runtime || (runtime.devices || []).indexOf("cuda") < 0;
      if (gpuOption.disabled && byId("deviceSelect").value === "gpu") byId("deviceSelect").value = "auto";
    }
    var hybridOption = byId("deviceSelect").querySelector('option[value="hybrid"]');
    if (hybridOption) {
      hybridOption.disabled = !runtime || (runtime.devices || []).indexOf("vulkan") < 0;
      if (hybridOption.disabled && byId("deviceSelect").value === "hybrid") byId("deviceSelect").value = "auto";
    }
  }

  function selectedRuntime() {
    if (!state.selectedModel || !state.selectedModel.runtimeCandidates || !state.selectedModel.runtimeCandidates.length) return null;
    var id = state.selectedModel.runtimeCandidates[0].runtimeId;
    return state.runtimes.filter(function (runtime) { return runtime.id === id; })[0] || null;
  }

  function scan(mode, restoredPath) {
    byId("scanMenu").open = false;
    if (mode === "specifiedDirectory") {
      var directory = restoredPath || choosePath(true, "选择 Whisper 模型文件夹");
      if (!directory) return;
      state.scanMode = mode;
      state.scanPath = directory;
      setText("scanPathLabel", directory);
      setStatus("loading", "正在扫描指定文件夹", directory);
      return modelScanner.inspectSpecified(directory, { recursive: true, maxDepth: 12 }, function (error, result) { completeScan(error, result); });
    }
    if (mode === "fullDisk") {
      state.scanMode = mode;
      state.scanPath = null;
      setText("scanPathLabel", "全盘扫描");
      setStatus("loading", "正在全盘扫描", "扫描所有可访问磁盘中的 Whisper 模型");
      return modelScanner.scanModels({ mode: mode, extensionRoot: root, maxEntries: 300000, maxDepth: 12, maxDurationMs: 0 }, completeScan);
    }
  }

  function completeScan(error, result) {
    if (error) { setStatus("error", "模型扫描失败", error.message); return; }
    detectEnvironment(result.models || [], function (runtimeError) {
      if (runtimeError) { setStatus("error", "运行环境检测失败", runtimeError.message); return; }
      renderModels();
      saveSettings();
    });
  }

  function renderUvr5Models(preferredId, enabled) {
    var select = byId("uvr5ModelSelect");
    var toggle = byId("enableUvr5Input");
    select.innerHTML = "";
    state.uvr5Models = state.uvr5Models.filter(function (model) {
      model.compatible = !!model.path && !!model.uvrRoot && !!model.pythonExecutable && fs.existsSync(model.path) && fs.existsSync(path.join(model.uvrRoot, "vr.py")) && fs.existsSync(model.pythonExecutable);
      return !!model.path;
    });
    state.uvr5Models.forEach(function (model, index) {
      var option = document.createElement("option");
      option.value = String(index);
      option.textContent = model.displayName + (model.compatible ? "" : " · 缺少环境");
      option.disabled = !model.compatible;
      select.appendChild(option);
    });
    var selectedIndex = state.uvr5Models.findIndex(function (model) { return model.compatible && model.id === preferredId; });
    if (selectedIndex < 0) selectedIndex = state.uvr5Models.findIndex(function (model) { return model.compatible && /HP2_all_vocals/i.test(model.displayName); });
    if (selectedIndex < 0) selectedIndex = state.uvr5Models.findIndex(function (model) { return model.compatible; });
    if (selectedIndex >= 0) {
      select.value = String(selectedIndex);
      select.disabled = false;
      state.selectedUvr5Model = state.uvr5Models[selectedIndex];
      toggle.disabled = false;
      toggle.checked = enabled === true;
      byId("uvr5Row").dataset.ready = "true";
      setText("uvr5PathLabel", state.selectedUvr5Model.path);
      select.title = state.selectedUvr5Model.path;
    } else {
      var option = document.createElement("option");
      option.value = ""; option.textContent = "未找到模型"; select.appendChild(option);
      select.disabled = true;
      state.selectedUvr5Model = null;
      toggle.checked = false; toggle.disabled = true;
      byId("uvr5Row").dataset.ready = "false";
      select.title = "未找到可用 UVR5 模型";
    }
  }

  function scanUvr5(mode, restoredPath) {
    byId("uvr5ScanMenu").open = false;
    var callback = function (error, result) {
      if (error) { setStatus("error", "UVR5 扫描失败", error.message); return; }
      state.uvr5Models = result.models || [];
      renderUvr5Models(state.settings && state.settings.selectedUvr5ModelId, state.settings && state.settings.uvr5Enabled);
      saveSettings();
      setStatus(state.selectedUvr5Model ? "ready" : "warning", state.selectedUvr5Model ? "UVR5 模型可用" : "未找到可用 UVR5 模型", state.selectedUvr5Model ? state.selectedUvr5Model.displayName : "可重新指定文件夹或全盘扫描");
    };
    if (mode === "specifiedDirectory") {
      var directory = restoredPath || choosePath(true, "选择 UVR5 模型文件夹");
      if (!directory) return;
      state.uvr5ScanMode = mode; state.uvr5ScanPath = directory;
      setText("uvr5PathLabel", directory);
      setStatus("loading", "正在扫描 UVR5 模型", directory);
      return uvr5ModelScanner.inspectSpecified(directory, { maxDepth: 12 }, callback);
    }
    state.uvr5ScanMode = "fullDisk"; state.uvr5ScanPath = null;
    setText("uvr5PathLabel", "全盘扫描");
    setStatus("loading", "正在全盘扫描 UVR5 模型", "扫描所有可访问磁盘");
    uvr5ModelScanner.scanModels({ mode: "fullDisk", maxDepth: 12, maxEntries: 300000 }, callback);
  }

  function choosePythonRuntime() {
    var interpreter = choosePath(false, "选择 Python 运行时", ["exe"]);
    if (!interpreter) return;
    if (path.basename(interpreter).toLowerCase() !== "python.exe") {
      return showDialog("Python 运行时无效", "请选择 Python 环境中的 python.exe。", null, null);
    }
    state.pythonPaths = [interpreter];
    saveSettings();
    setText("pythonRuntimePath", interpreter);
    setStatus("loading", "正在检测指定 Python 运行时", interpreter);
    detectEnvironment(state.models, function (error) {
      if (error) return setStatus("error", "Python 运行时检测失败", error.message);
      renderModels();
    });
  }

  function renderOrderedList(element, items, recorder, onChange) {
    element.innerHTML = "";
    if (!items.length) {
      var empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "未选择";
      element.appendChild(empty);
      return;
    }
    items.forEach(function (item, index) {
      var row = document.createElement("li");
      var order = document.createElement("b");
      order.textContent = String(index + 1);
      var name = document.createElement("span");
      name.textContent = item.name || "Layer " + item.layerId;
      name.title = name.textContent;
      var up = document.createElement("button");
      up.type = "button"; up.title = "上移"; up.setAttribute("aria-label", "上移 " + name.textContent); up.innerHTML = '<i data-lucide="chevron-up"></i>'; up.disabled = index === 0;
      var down = document.createElement("button");
      down.type = "button"; down.title = "下移"; down.setAttribute("aria-label", "下移 " + name.textContent); down.innerHTML = '<i data-lucide="chevron-down"></i>'; down.disabled = index === items.length - 1;
      up.addEventListener("click", function () { recorder.move(index, index - 1); if (onChange) onChange(); });
      down.addEventListener("click", function () { recorder.move(index, index + 1); if (onChange) onChange(); });
      row.appendChild(order); row.appendChild(name); row.appendChild(up); row.appendChild(down); element.appendChild(row);
    });
    if (window.lucide) window.lucide.createIcons();
  }

  var templateTree = new PropertyTree(byId("templatePropertyTree"), { onChange: function (selection) { state.templateModules = selection; } });
  var effectTree = new PropertyTree(byId("effectPropertyTree"), { onChange: function (selection) { state.effectModules = selection; } });

  var templateRecorder = new SelectionRecorder(bridge, { textOnly: true, onUpdate: function (items) { renderOrderedList(byId("templateLayerList"), items, templateRecorder); }, onError: recorderError });
  var effectSourceRecorder = new SelectionRecorder(bridge, { textOnly: false, onUpdate: function (items) { renderOrderedList(byId("effectSourceList"), items, effectSourceRecorder); }, onError: recorderError });
  var effectTargetRecorder = new SelectionRecorder(bridge, { textOnly: false, onUpdate: function (items) { renderOrderedList(byId("effectTargetList"), items, effectTargetRecorder); }, onError: recorderError });

  function recorderError(error) { showDialog("选择记录已停止", error.message + (error.code ? "\n" + error.code : "")); }

  function toggleRecorder(button, recorder, list, afterStop, peerButton) {
    if (recorder.recording) {
      var items = recorder.stop();
      button.classList.remove("recording");
      button.setAttribute("aria-pressed", "false");
      button.querySelector("span").textContent = button.dataset.idleLabel;
      if (peerButton) peerButton.disabled = false;
      renderOrderedList(list, items, recorder, afterStop);
      if (afterStop) afterStop();
    } else {
      button.dataset.idleLabel = button.querySelector("span").textContent;
      button.classList.add("recording");
      button.setAttribute("aria-pressed", "true");
      button.querySelector("span").textContent = "结束记录";
      if (peerButton) peerButton.disabled = true;
      recorder.start(function (error) { if (error) recorderError(error); });
    }
  }

  function loadTreeFor(items, tree, responseName, callback) {
    if (!items.length) { tree.clear("没有可读取的来源层"); if (callback) callback(new Error("没有可读取的来源层")); return; }
    var responseRoot = path.join(os.tmpdir(), "LocalWhisperSubtitles");
    tempStore.ensureDirectory(responseRoot);
    Promise.all(items.map(function (item, index) {
      var responsePath = path.join(responseRoot, responseName + "-" + Date.now() + "-" + index + ".json");
      return hostCall("ae.layer.tree", { compId: item.compId, layerId: item.layerId, responseFile: responsePath }).then(function (result) {
        var data = result.data;
        if (data.transport === "jsonFile") data = JSON.parse(fs.readFileSync(data.path, "utf8"));
        else if (data.transport === "inline") data = data.value;
        try { fs.unlinkSync(responsePath); } catch (ignore) {}
        return { item: item, tree: data.tree };
      });
    })).then(function (results) {
      if (results.length === 1) tree.render(results[0].tree);
      else tree.render({ name: "已选来源", children: results.map(function (result, index) { return { name: (index + 1) + " · " + (result.item.name || "Layer " + result.item.layerId), matchName: "LWS Source Group", children: result.tree.children && result.tree.children.length ? result.tree.children : [result.tree] }; }) });
      if (callback) callback(null);
    }).catch(function (error) { tree.clear(error.message); if (callback) callback(error); });
  }

  function makePickerRow(type, name, meta, checked) {
    var label = document.createElement("label");
    label.className = "picker-row";
    var input = document.createElement("input");
    input.type = type;
    input.checked = !!checked;
    var copy = document.createElement("span");
    var title = document.createElement("strong");
    title.textContent = name;
    var detail = document.createElement("small");
    detail.textContent = meta || "";
    copy.appendChild(title);
    copy.appendChild(detail);
    label.appendChild(input);
    label.appendChild(copy);
    return { label: label, input: input };
  }

  function updateAepPickerCount() {
    var picker = state.aepPicker;
    if (!picker) return;
    var count = all("#aepLayerList input:checked").length;
    var compStep = picker.step === "comps" || picker.step === "effectComps";
    setText("aepPickerCount", compStep ? picker.comps.length + " 个可用合成" : count + " 个文本图层");
    byId("aepNextButton").disabled = (picker.step === "layers" || picker.step === "effectLayers") && count === 0;
  }

  function renderAepComps() {
    var picker = state.aepPicker;
    var list = byId("aepCompList");
    list.innerHTML = "";
    picker.comps.forEach(function (comp, index) {
      var row = makePickerRow("radio", comp.name, comp.textLayerCount + " 个文本图层", index === 0);
      row.input.name = "aepComp";
      row.input.value = String(index);
      row.input.addEventListener("change", updateAepPickerCount);
      list.appendChild(row.label);
    });
    var effectMode = picker.step === "effectComps" || picker.step === "effectLayers";
    picker.step = effectMode ? "effectComps" : "comps";
    setText("aepDialogTitle", effectMode ? "选择效果来源合成" : "选择合成");
    setText("aepNextButton", "下一步");
    byId("aepBackButton").hidden = true;
    byId("aepCompList").hidden = false;
    byId("aepLayerList").hidden = true;
    updateAepPickerCount();
  }

  function renderAepLayers(comp, layers, effectMode) {
    var picker = state.aepPicker;
    var list = byId("aepLayerList");
    // The AEP effect-source picker is intentionally text-only. Keep this
    // guard in the UI as well as in the host route so a malformed/extended
    // host response can never expose ordinary footage or shape layers here.
    layers = (layers || []).filter(function (layer) { return layer && layer.isText === true; });
    list.innerHTML = "";
    picker.selectedComp = comp;
    picker.layers = layers;
    layers.forEach(function (layer, index) {
      layer.compId = comp.compId;
      var row = makePickerRow("checkbox", layer.name, "图层 " + layer.index, true);
      row.input.value = String(index);
      row.input.addEventListener("change", updateAepPickerCount);
      list.appendChild(row.label);
    });
    picker.step = effectMode ? "effectLayers" : "layers";
    setText("aepDialogTitle", effectMode ? "选择效果来源文本图层" : "选择文本图层");
    setText("aepNextButton", "使用所选图层");
    byId("aepBackButton").hidden = false;
    byId("aepCompList").hidden = true;
    byId("aepLayerList").hidden = false;
    updateAepPickerCount();
  }

  function useAepAsEffectSource(selected) {
    var items = (selected || []).filter(function (layer) { return layer && layer.isText === true; }).map(function (layer) {
      return { compId: layer.compId, layerId: layer.layerId, index: layer.index, name: layer.name, isText: layer.isText, hasAudio: layer.hasAudio };
    });
    if (!items.length) return;
    state.effectTreeLoading = true;
    effectSourceRecorder.setItems(items);
    updateEffectButton();
    loadTreeFor(items, effectTree, "effect-tree", function (error) {
      state.effectTreeLoading = false;
      updateEffectButton();
      if (error) setStatus("error", "AEP 效果属性读取失败", error.message);
      else setStatus("ready", "AEP 效果来源已载入", items.length + " 个来源图层");
    });
  }

  function chooseEffectAep() {
    var aep = choosePath(false, "选择 AEP 效果来源", ["aep", "aet"]);
    if (!aep) return;
    setStatus("loading", "正在导入 AEP 效果来源", path.basename(aep));
    hostCall("ae.aep.import", { path: aep }).then(function (result) {
      var comps = result.data.comps || [];
      if (!comps.length) throw new Error("AEP 中没有包含文本图层的合成");
      state.aepPicker = { path: aep, comps: comps, selectedComp: null, layers: [], step: "effectComps" };
      setText("aepFileName", path.basename(aep));
      renderAepComps();
      byId("aepDialog").showModal();
      setStatus("ready", "AEP 效果来源已导入", comps.length + " 个可用合成");
    }).catch(function (error) { setStatus("error", "AEP 效果来源读取失败", error.message); });
  }

  function advanceAepPicker() {
    var picker = state.aepPicker;
    if (!picker) return;
    if (picker.step === "comps" || picker.step === "effectComps") {
      var effectMode = picker.step === "effectComps";
      var selectedCompInput = document.querySelector('#aepCompList input[name="aepComp"]:checked');
      if (!selectedCompInput) return;
      var comp = picker.comps[Number(selectedCompInput.value)];
      byId("aepNextButton").disabled = true;
      setText("aepPickerCount", "正在读取文本图层");
      hostCall("ae.comp.listTextLayers", { compId: comp.compId }).then(function (result) {
        var layers = result.data.layers || [];
        if (!layers.length) throw new Error("所选合成没有文本图层");
        renderAepLayers(comp, layers, effectMode);
      }).catch(function (error) {
        byId("aepNextButton").disabled = false;
        setText("aepPickerCount", "读取失败");
        showDialog("AEP 文本图层读取失败", error.message);
      });
      return;
    }
    var selected = all("#aepLayerList input:checked").map(function (input) { return picker.layers[Number(input.value)]; });
    if (!selected.length) return;
    if (picker.step === "effectLayers") useAepAsEffectSource(selected);
    else {
      templateRecorder.setItems(selected);
      loadTreeFor(selected, templateTree, "template-tree");
      setStatus("ready", "AEP 模板已载入", selected.length + " 个文本图层");
    }
    byId("aepDialog").close("confirm");
    state.aepPicker = null;
  }

  function chooseAep() {
    var aep = choosePath(false, "选择 AEP 字幕模板", ["aep", "aet"]);
    if (!aep) return;
    setStatus("loading", "正在导入 AEP 模板", path.basename(aep));
    hostCall("ae.aep.import", { path: aep }).then(function (result) {
      var comps = result.data.comps || [];
      if (!comps.length) throw new Error("AEP 中没有新增的文本合成");
      state.aepPicker = { path: aep, comps: comps, selectedComp: null, layers: [], step: "comps" };
      setText("aepFileName", path.basename(aep));
      renderAepComps();
      byId("aepDialog").showModal();
      setStatus("ready", "AEP 模板已导入", comps.length + " 个包含文本的合成");
    }).catch(function (error) { setStatus("error", "AEP 模板读取失败", error.message); });
  }

  function styleSettings() {
    return { fontPostScriptName: byId("fontInput").value.trim(), font: byId("fontInput").value.trim(), fontSize: numberValue("fontSizeInput", 72), tracking: numberValue("trackingInput", 0), leading: numberValue("leadingInput", 86), center: { unit: "percent", x: numberValue("positionX", 50), y: numberValue("positionY", 88) } };
  }

  function translationSettings() {
    var targets = [];
    if (state.translationMode === "single") targets.push(byId("targetLanguageA").value);
    if (state.translationMode === "bilingual") targets.push(byId("targetLanguageA").value, byId("targetLanguageB").value);
    var reference = targets.length ? "translation-session" : null;
    if (reference) state.sessionApiKeys[reference] = byId("apiKeyInput").value;
    return { mode: state.translationMode, targetLanguages: targets, baseUrl: byId("apiBaseUrl").value.trim(), model: byId("translationModel").value.trim(), apiKeyRef: reference, timeoutMs: 60000, batchMaxSegments: 30 };
  }

  function updateReadyState() {
    var sttEnabled = byId("enableSttInput").checked;
    var ready = sttEnabled && !!state.context && !!state.range && !!state.selectedModel && !!selectedRuntime() && !!state.outputMode && !state.busy;
    byId("runButton").disabled = !ready;
    setText("runStatus", state.busy ? "任务执行中" : (!sttEnabled ? "STT 已关闭，特效复制仍可独立使用" : (ready ? "可以生成字幕" : "等待宿主、范围和可用模型")));
  }

  function updateSttVisibility() {
    var enabled = byId("enableSttInput").checked;
    all(".stt-feature").forEach(function (element) { element.hidden = !enabled; });
    byId("transcriptionDetails").open = true;
    updateCompTemplateVisibility();
    updateReadyState();
  }

  function progress(phase, percent, detail) {
    byId("progressWrap").hidden = false;
     var labels = { preparingAudio: "处理音频", separatingVocals: "UVR5 人声提取", detectingSpeech: "FunASR VAD 语音边界", loadingModel: "加载模型", transcribing: "本地转写", segmenting: "自动断句", translating: "翻译字幕", writingHost: "写入 Adobe" };
    setText("progressText", labels[phase] || phase);
    setText("progressPercent", percent === null || percent === undefined ? "" : Math.round(percent) + "%");
    var bar = byId("progressBar");
    if (percent === null || percent === undefined) { bar.classList.add("indeterminate"); bar.style.width = "36%"; }
    else { bar.classList.remove("indeterminate"); bar.style.width = Math.max(0, Math.min(100, percent)) + "%"; }
    if (detail) state.runProgressContext = detail;
    if (state.runProgressContext) setText("runStatus", state.runProgressContext + (state.runStartedAt ? " · 已用 " + formatElapsed(Date.now() - state.runStartedAt) : ""));
  }

  function formatElapsed(milliseconds) {
    var total = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function startRunClock() {
    if (state.runTimer) clearInterval(state.runTimer);
    state.runStartedAt = Date.now();
    state.activePlacement = null;
    state.runTimer = setInterval(function () {
      if (!state.busy || !state.runProgressContext) return;
      setText("runStatus", state.runProgressContext + " · 已用 " + formatElapsed(Date.now() - state.runStartedAt));
    }, 1000);
  }

  function stopRunClock() {
    if (state.runTimer) clearInterval(state.runTimer);
    state.runTimer = null;
    state.runStartedAt = 0;
    state.runProgressContext = "";
    state.activeDevice = null;
    state.activePlacement = null;
  }

  function createAudioExport(jobDirectory) {
    var outputPath = path.join(jobDirectory, "timeline.wav");
    if (state.host === "AEFT") {
      return hostCall("ae.selection.snapshot").then(function (selection) {
        var layers = selection.data && selection.data.layers || [];
        var layerIds = layers.map(function (layer) { return layer.layerId; });
        if (!layerIds.length) {
          var selectionError = new Error("请先在 AE 合成中选择一个或多个音频/视频图层");
          selectionError.code = "AE_AUDIO_LAYER_SELECTION_REQUIRED";
          throw selectionError;
        }
        return hostCall("ae.audio.export", { compId: state.context.activeComp.itemId, start: state.range.start, end: state.range.end, layerIds: layerIds });
      }).then(function (result) {
        var data = result.data || {};
        var sources = data.sources || [];
        if (!sources.length && data.path) sources = [data];
        if (!sources.length) {
          var sourceError = new Error("选中的图层没有可直接读取的音频/视频源文件");
          sourceError.code = "AE_AUDIO_SOURCE_NOT_FOUND";
          throw sourceError;
        }
        return { sources: sources, warnings: result.envelope && result.envelope.warnings || [] };
      });
    }
    var preset = path.join(root, "presets", "LocalWhisper_PCM_16k_Mono.epr");
    return hostCall("pr.audio.export", { outputPath: outputPath, presetPath: preset }).then(function (result) {
      return new Promise(function (resolve, reject) {
        state.encoderJobs[result.data.jobId] = { resolve: function (event) { resolve({ sources: [{ path: event.outputPath || outputPath, inMs: Math.round(Number(state.range.start.seconds) * 1000), outMs: Math.round(Number(state.range.end.seconds) * 1000) }], warnings: [] }); }, reject: reject };
      });
    });
  }

  function runTranscription() {
    if (!byId("enableSttInput").checked || state.busy || !state.selectedModel || !selectedRuntime()) return;
    if (byId("enableUvr5Input").checked && !state.selectedUvr5Model) return showDialog("UVR5 未配置", "请先扫描并选择可用的 UVR5 模型，或关闭 UVR5。", null);
    if (state.host === "AEFT" && state.outputMode === "compTemplate" && (!state.compTemplate || !state.compTemplate.textLayerIds.length)) return showDialog("合成模板未配置", "请先在“合成模板”中选择模板合成，并保留至少一个勾选的内部文字图层。", null);
    var translation = translationSettings();
    if (translation.targetLanguages.length && (!translation.baseUrl || !translation.model || !state.sessionApiKeys[translation.apiKeyRef])) return showDialog("翻译设置不完整", "请选择翻译模型并填写本次使用的 API Key。", null);
    if (translation.targetLanguages.length === 2 && translation.targetLanguages[0] === translation.targetLanguages[1]) return showDialog("双语设置重复", "语言 A 和语言 B 需要选择不同语言。", null);
    state.busy = true;
    startRunClock();
    updateReadyState();
    byId("cancelButton").hidden = false;
    var exportStore = tempStore.create(path.join(os.tmpdir(), "LocalWhisperSubtitles"), "export");
    progress("preparingAudio", null, state.host === "AEFT" ? "正在读取选中图层素材源" : "正在准备序列音频");
    createAudioExport(exportStore.directory).then(function (audioBatch) {
      var sources = audioBatch.sources || [];
      var runtime = selectedRuntime();
      if (!sources.length) throw new Error("没有可处理的音频源");
      setText("runStatus", state.host === "AEFT" ? "已找到 " + sources.length + " 个选中图层，开始逐一识别" : "序列 In/Out 音频已准备，开始识别");
      var summary = { jobId: "job-" + Date.now(), segmentCount: 0, skippedSources: 0, cleanedSources: 0, manualCaptionImports: 0, totalSources: sources.length, engine: { name: runtime.engine }, warnings: (audioBatch.warnings || []).slice() };
      function runSource(index) {
        if (index >= sources.length) {
          if (!summary.segmentCount) return finishRun(null, null, summary);
          return finishRun(null, { data: { count: summary.segmentCount } }, summary);
        }
        var source = sources[index];
        var runner = new Runner({ runtimeDescriptor: runtime, modelDescriptor: state.selectedModel, ffmpegPath: state.ffmpeg, tempRoot: path.join(os.tmpdir(), "LocalWhisperSubtitles"), vadModelPath: findVadModel(), vadPythonExecutable: findVadPython(), vadBridgePath: path.join(root, "python", "vad_bridge.py"), whispercppVadModelPath: findWhisperCppVadModel(), uvr5BridgePath: path.join(root, "python", "uvr5_bridge.py"), getApiKey: function (reference) { return state.sessionApiKeys[reference] || null; } });
        state.currentRunner = runner;
        runner.on("progress", function (event) {
          if (event.detail && event.detail.device) state.activeDevice = event.detail.device;
          if (event.detail && event.detail.placement) state.activePlacement = event.detail.placement;
          var percent = event.phasePercent === null || event.phasePercent === undefined ? null : (index * 100 + Number(event.phasePercent)) / sources.length;
          var deviceLabel = state.activePlacement === "hybrid" || state.activeDevice === "vulkan" ? "GPU + CPU 混合" : (state.activeDevice === "cuda" ? "GPU" : (state.activeDevice === "cpu" ? "CPU" : "正在调度"));
          progress(event.phase, percent, (state.host === "AEFT" ? "图层 " + (index + 1) + "/" + sources.length : "序列音频") + " · " + deviceLabel + " · " + runtime.engine);
        });
        runner.on("warning", function (warning) { setText("runStatus", warning.message); });
        var timelineInMs = Number(source.timelineInMs !== undefined ? source.timelineInMs : source.inMs);
        var timelineOutMs = Number(source.timelineOutMs !== undefined ? source.timelineOutMs : source.outMs);
        var job = { schemaVersion: 1, jobId: summary.jobId + "-source-" + index, audioInput: { path: source.path, timelineInMs: timelineInMs, timelineOutMs: timelineOutMs, sourceStartMs: Number(source.sourceStartMs) || 0, sourceEndMs: Number(source.sourceEndMs) || null, playbackRate: Number(source.playbackRate) || 1, reverse: source.reverse === true, layerId: source.layerId || null, alreadyTrimmed: false }, preprocessing: { uvr5Enabled: byId("enableUvr5Input").checked, uvr5Model: state.selectedUvr5Model }, model: state.selectedModel, runtime: runtime, transcription: { language: byId("languageSelect").value, devicePolicy: byId("deviceSelect").value, wordTimestamps: true, vad: true }, segmentation: { mode: "smart", maxCharsPerLine: numberValue("maxLineCharsInput", 0), maxLines: byId("maxLinesInput").disabled ? null : numberValue("maxLinesInput", 2) }, translation: translation };
        runner.run(job, function (error, result) {
          state.currentRunner = null;
          if (error) return finishRun(error);
          if (result.status === "skipped") summary.skippedSources += 1;
          if (result.engine && result.engine.preprocessing && result.engine.preprocessing.uvr5) summary.cleanedSources += 1;
          summary.segmentCount += (result.segments || []).length;
          (result.warnings || []).forEach(function (warning) { summary.warnings.push(warning); });
          if (result.status === "skipped" || !(result.segments || []).length) return runSource(index + 1);
          writeHostResult(result, source).then(function (hostWriteResult) {
            if (hostWriteResult && hostWriteResult.data && hostWriteResult.data.requiresManualPlacement) summary.manualCaptionImports += 1;
            progress("writingHost", (index + 1) * 100 / sources.length, state.host === "AEFT" ? "已写入图层 " + (index + 1) + "/" + sources.length + " 的独立字幕" : "已创建序列字幕");
            runSource(index + 1);
          }).catch(finishRun);
        });
      }
      runSource(0);
    }).catch(finishRun);
  }

  function findVadModel() {
    var managed = path.join(process.env.LOCALAPPDATA || os.homedir(), "LocalWhisperSubtitles", "vad");
    var candidates = [path.join(managed, "speech_fsmn_vad_zh-cn-16k-common-pytorch"), path.join(root, "..", "resources", "vad", "speech_fsmn_vad_zh-cn-16k-common-pytorch")];
    function addSiblingCandidates(start) {
      var current = start;
      for (var depth = 0; depth < 8 && current && current !== path.dirname(current); depth += 1) {
        try { fs.readdirSync(current).forEach(function (name) { if (/vad/i.test(name)) candidates.push(path.join(current, name)); }); } catch (ignore) {}
        current = path.dirname(current);
      }
    }
    if (state.selectedModel && state.selectedModel.path) addSiblingCandidates(path.dirname(state.selectedModel.path));
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      try { if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, "model.pt"))) return candidate; } catch (ignoreCandidate) {}
    }
    return null;
  }

  function findVadPython() {
    if (state.pythonPaths && state.pythonPaths[0] && fs.existsSync(state.pythonPaths[0])) return state.pythonPaths[0];
    return null;
  }

  function findWhisperCppVadModel() {
    var managed = path.join(process.env.LOCALAPPDATA || os.homedir(), "LocalWhisperSubtitles", "vad");
    var bundled = path.join(root, "..", "resources", "vad");
    var candidates = [
      path.join(managed, "silero-vad.bin"),
      path.join(managed, "ggml-silero-v6.2.0.bin"),
      path.join(root, "..", "resources", "vad", "ggml-silero-v6.2.0.bin"),
      path.join(bundled, "silero-vad.bin")
    ];
    [managed, bundled].forEach(function (directory) {
      try {
        fs.readdirSync(directory).sort().forEach(function (name) {
          if (/^ggml-silero-v[0-9.]+\.bin$/i.test(name)) candidates.push(path.join(directory, name));
        });
      } catch (ignoreDirectory) {}
    });
    return candidates.filter(function (candidate) { return fs.existsSync(candidate); })[0] || null;
  }

  function displayLanguages() {
    if (state.translationMode === "source") return ["source"];
    if (state.translationMode === "single") return [byId("targetLanguageA").value];
    return [byId("targetLanguageA").value, byId("targetLanguageB").value];
  }

  function writeHostResult(result, source) {
    progress("writingHost", null, "正在创建 Adobe 字幕对象");
    var style = styleSettings();
    if (state.host === "AEFT") {
      if (state.outputMode === "compTemplate") {
        if (!state.compTemplate || !state.compTemplate.textLayerIds || !state.compTemplate.textLayerIds.length) throw new Error("请先在“合成模板”中选择模板合成并保留至少一个勾选文字图层");
        return hostCall("ae.comp.subtitles.create", { compId: state.context.activeComp.itemId, segmentsFile: result.artifacts.json, templateCompId: state.compTemplate.compId, textLayerIds: state.compTemplate.textLayerIds, displayLanguages: displayLanguages(), layerPrefix: "LWS 合成字幕" });
      }
      return hostCall("ae.subtitles.create", { compId: state.context.activeComp.itemId, mode: state.outputMode, segmentsFile: result.artifacts.json, displayLanguages: displayLanguages(), templateLayers: templateRecorder.getItems().map(function (item) { return { compId: item.compId, layerId: item.layerId }; }), moduleSelections: templateTree.getSelection(), position: style.center, styleOverrides: { font: style.font, fontSize: style.fontSize, tracking: style.tracking, leading: style.leading }, layerPrefix: source && source.layerName ? "LWS 字幕 · " + source.layerName : "LWS 字幕" });
    }
    var srtPath = path.join(path.dirname(result.artifacts.json), "captions.srt");
    var languages = displayLanguages();
    var outputSegments = result.segments.map(function (segment) {
      var values = languages.map(function (language) { return language === "source" ? segment.sourceText : (segment.translations[language] && segment.translations[language].text || segment.sourceText); });
      return { startMs: segment.startMs, endMs: segment.endMs, sourceText: values.join("\n") };
    });
    fs.writeFileSync(srtPath, srt.toSrt(outputSegments), "utf8");
    return hostCall("pr.subtitles.captions.create", { srtPath: srtPath, startSeconds: 0 });
  }

  function finishRun(error, hostResult, transcriptionResult) {
    state.busy = false;
    state.currentRunner = null;
    stopRunClock();
    byId("cancelButton").hidden = true;
    byId("progressWrap").hidden = true;
    updateReadyState();
    if (error) {
      setStatus(error.code === "E_JOB_CANCELED" ? "warning" : "error", error.code === "E_JOB_CANCELED" ? "任务已取消" : "字幕任务失败", error.message + (error.code ? " · " + error.code : ""));
      return;
    }
    var count = transcriptionResult && transcriptionResult.segmentCount !== undefined ? transcriptionResult.segmentCount : (transcriptionResult && transcriptionResult.segments ? transcriptionResult.segments.length : (hostResult && hostResult.data && hostResult.data.count || 0));
    if (!count) {
      setStatus("warning", "没有检测到可识别语音", transcriptionResult && transcriptionResult.skippedSources ? "选中的图层没有音频波形，已跳过" : "未创建字幕图层");
      return;
    }
    if (transcriptionResult && transcriptionResult.manualCaptionImports) {
      setStatus("warning", "SRT 字幕已导入项目", count + " 条 · 当前 Premiere Pro 需要把导入的字幕素材手动拖入时间轴");
      return;
    }
    setStatus("ready", "字幕已生成", count + " 条 · " + (transcriptionResult && transcriptionResult.engine ? transcriptionResult.engine.name : "Adobe"));
  }

  function applyEffects() {
    var sources = effectSourceRecorder.getItems();
    var targets = effectTargetRecorder.getItems();
    if (!sources.length || !targets.length) return;
    var moduleIds = effectTree.selectedModuleIds();
    if (!moduleIds.length) return showDialog("没有选择可复制项目", "请等待属性树加载完成，并至少保留一个已勾选项目。", null);
    byId("applyEffectsButton").disabled = true;
    setStatus("loading", "正在等比例复制效果", sources.length + " 个来源 → " + targets.length + " 个目标");
    hostCall("ae.modules.copy", { sources: sources.map(function (item) { return { compId: item.compId, layerId: item.layerId, moduleIds: moduleIds }; }), targets: targets.map(function (item) { return { compId: item.compId, layerId: item.layerId }; }), keyframeTimeMode: "fitLayerEffectiveRange" }).then(function (result) {
      setStatus(result.envelope && result.envelope.warnings && result.envelope.warnings.length ? "warning" : "ready", "效果复制完成", result.data.count + " 个目标层");
      updateEffectButton();
    }).catch(function (error) { setStatus("error", "效果复制失败", error.message); updateEffectButton(); });
  }

  function bindUi() {
    populateLanguages();
    byId("refreshContextButton").addEventListener("click", loadContext);
    all("[data-scan]").forEach(function (button) { button.addEventListener("click", function () { scan(button.dataset.scan); }); });
    all("[data-uvr5-scan]").forEach(function (button) { button.addEventListener("click", function () { scanUvr5(button.dataset.uvr5Scan); }); });
    byId("enableSttInput").addEventListener("change", function () { updateSttVisibility(); saveSettings(); });
    byId("enableUvr5Input").addEventListener("change", saveSettings);
    byId("uvr5ModelSelect").addEventListener("change", function () { state.selectedUvr5Model = state.uvr5Models[Number(this.value)] || null; setText("uvr5PathLabel", state.selectedUvr5Model ? state.selectedUvr5Model.path : "未选择"); this.title = state.selectedUvr5Model ? state.selectedUvr5Model.path : "未选择"; saveSettings(); });
    byId("choosePythonRuntimeButton").addEventListener("click", choosePythonRuntime);
    ["deviceSelect", "languageSelect", "apiBaseUrl", "translationModel", "targetLanguageA", "targetLanguageB"].forEach(function (id) { byId(id).addEventListener("change", saveSettings); });
    byId("modelSelect").addEventListener("change", function () { state.selectedModel = state.models[Number(this.value)] || null; renderRuntime(); updateReadyState(); saveSettings(); });
    all("[data-translation-mode]").forEach(function (button) { button.addEventListener("click", function () { all("[data-translation-mode]").forEach(function (item) { item.classList.toggle("active", item === button); }); state.translationMode = button.dataset.translationMode; byId("translationFields").hidden = state.translationMode === "source"; byId("targetLanguageBField").hidden = state.translationMode !== "bilingual"; saveSettings(); }); });
    all("[data-tab]").forEach(function (button) { button.addEventListener("click", function () { all("[data-tab]").forEach(function (item) { item.setAttribute("aria-selected", item === button ? "true" : "false"); }); all("[data-panel]").forEach(function (panel) { panel.hidden = panel.dataset.panel !== button.dataset.tab; }); }); });
    all("#positionGrid button").forEach(function (button) { button.addEventListener("click", function () { all("#positionGrid button").forEach(function (item) { item.classList.remove("active"); }); button.classList.add("active"); byId("positionX").value = button.dataset.x; byId("positionY").value = button.dataset.y; updatePreview(); }); });
    ["positionX", "positionY", "fontInput", "fontSizeInput", "trackingInput", "leadingInput", "maxLineCharsInput", "maxLinesInput"].forEach(function (id) { byId(id).addEventListener("input", function () { updatePreview(); saveSettings(); }); });
    byId("maxLineCharsInput").addEventListener("input", function () { byId("maxLinesInput").disabled = Number(this.value) === 0; });
    all("[data-output]").forEach(function (button) { button.addEventListener("click", function () { var parent = button.parentElement; Array.prototype.slice.call(parent.querySelectorAll("button")).forEach(function (item) { item.classList.toggle("active", item === button); }); state.outputMode = button.dataset.output; updateCompTemplateVisibility(); saveSettings(); }); });
    byId("recordTemplatesButton").addEventListener("click", function () { toggleRecorder(this, templateRecorder, byId("templateLayerList"), function () { loadTreeFor(templateRecorder.getItems(), templateTree, "template-tree"); }); });
    byId("chooseAepButton").addEventListener("click", chooseAep);
    byId("chooseEffectAepButton").addEventListener("click", chooseEffectAep);
    byId("aepNextButton").addEventListener("click", advanceAepPicker);
    byId("aepBackButton").addEventListener("click", renderAepComps);
    byId("aepDialog").addEventListener("close", function () { if (this.returnValue !== "confirm") state.aepPicker = null; });
    byId("refreshTreeButton").addEventListener("click", function () { loadTreeFor(templateRecorder.getItems(), templateTree, "template-tree"); });
    byId("recordEffectSourcesButton").addEventListener("click", function () { toggleRecorder(this, effectSourceRecorder, byId("effectSourceList"), function () { state.effectTreeLoading = true; updateEffectButton(); loadTreeFor(effectSourceRecorder.getItems(), effectTree, "effect-tree", function () { state.effectTreeLoading = false; updateEffectButton(); }); }, byId("recordEffectTargetsButton")); });
    byId("recordEffectTargetsButton").addEventListener("click", function () { toggleRecorder(this, effectTargetRecorder, byId("effectTargetList"), updateEffectButton, byId("recordEffectSourcesButton")); });
    byId("applyEffectsButton").addEventListener("click", applyEffects);
    byId("compTemplateSelect").addEventListener("change", onCompTemplateChange);
    byId("refreshCompTemplateButton").addEventListener("click", loadCompTemplateList);
    byId("runButton").addEventListener("click", runTranscription);
    byId("cancelButton").addEventListener("click", function () { if (state.currentRunner) state.currentRunner.cancel(); Object.keys(state.encoderJobs).forEach(function (id) { state.encoderJobs[id].reject(new Error("任务已取消")); delete state.encoderJobs[id]; }); });
    byId("downloadModelButton").addEventListener("click", function () { showDialog("获取推荐模型", "安装器会从外置 resources 清单安装或下载 ggml-large-v3-turbo-q5_0。当前面板不会静默下载。", "打开扫描菜单", function () { byId("scanMenu").open = true; }); });
    byId("testApiButton").addEventListener("click", function () { var config = translationSettings(); var apiKey = config.apiKeyRef ? state.sessionApiKeys[config.apiKeyRef] : byId("apiKeyInput").value; setText("runStatus", "正在读取翻译模型列表"); translationClient.listModels(config, apiKey, function (error, models) { apiKey = null; if (error) return showDialog("翻译 API 连接失败", error.message + (error.code ? "\n" + error.code : "")); if (models.length) byId("translationModel").value = models[0]; showDialog("翻译 API 可用", "已读取 " + models.length + " 个模型。", null); }); });
    byId("messageDialog").addEventListener("close", function () { if (this.returnValue === "confirm" && this._onConfirm) this._onConfirm(); this._onConfirm = null; });
    bridge.addEventListener("com.localwhisper.subtitles.encoder", function (event) {
      var data; try { data = JSON.parse(event.data); } catch (ignore) { return; }
      var pending = state.encoderJobs[data.jobId];
      if (!pending) return;
      if (data.type === "progress") progress("preparingAudio", Number(data.progress), "Adobe Media Encoder");
      if (data.type === "complete") { delete state.encoderJobs[data.jobId]; pending.resolve(data); }
      if (data.type === "error" || data.type === "canceled") { delete state.encoderJobs[data.jobId]; pending.reject(new Error(data.message || "Adobe Media Encoder 失败")); }
    });
  }

  function updatePreview() {
    var preview = byId("captionPreview");
    preview.style.left = numberValue("positionX", 50) + "%";
    preview.style.top = numberValue("positionY", 88) + "%";
    preview.style.fontFamily = '"' + byId("fontInput").value.replace(/["\\]/g, "") + '", sans-serif';
    preview.style.fontSize = Math.max(8, Math.min(16, numberValue("fontSizeInput", 72) / 6)) + "px";
    preview.style.letterSpacing = numberValue("trackingInput", 0) / 1000 + "em";
    preview.style.lineHeight = Math.max(10, Math.min(22, numberValue("leadingInput", 86) / 6)) + "px";
  }

  function updateEffectButton() { byId("applyEffectsButton").disabled = state.effectTreeLoading || effectSourceRecorder.recording || effectTargetRecorder.recording || !effectSourceRecorder.getItems().length || !effectTargetRecorder.getItems().length || !effectTree.selectedModuleIds().length; }

  function updateCompTemplateVisibility() {
    var details = byId("compTemplateDetails");
    if (!details) return;
    details.hidden = state.host !== "AEFT" || !byId("enableSttInput").checked || state.outputMode !== "compTemplate";
  }

  function loadCompTemplateList() {
    var select = byId("compTemplateSelect");
    if (!select || state.host !== "AEFT") return;
    hostCall("ae.aep.listComps", {}).then(function (result) {
      var comps = result.data && result.data.comps || [];
      state.compTemplateCandidates = comps;
      select.innerHTML = "";
      if (!comps.length) {
        var empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "项目中没有包含文字图层的合成";
        select.appendChild(empty);
        setText("compTemplateTiming", "节奏驱动：未选择模板");
        return;
      }
      comps.forEach(function (comp, index) {
        var option = document.createElement("option");
        option.value = String(index);
        option.textContent = comp.name + " · " + comp.width + "×" + comp.height + " · " + Number(comp.duration).toFixed(1) + "s · " + comp.textLayerCount + " 个文字层";
        select.appendChild(option);
      });
      onCompTemplateChange();
    }).catch(function (error) {
      select.innerHTML = "";
      var failed = document.createElement("option");
      failed.value = "";
      failed.textContent = "合成列表读取失败";
      select.appendChild(failed);
      setText("compTemplateTiming", "节奏驱动：读取失败 · " + error.message);
    });
  }

  function onCompTemplateChange() {
    var select = byId("compTemplateSelect");
    var comp = state.compTemplateCandidates[Number(select.value)];
    state.compTemplate = null;
    var container = byId("compTemplateTextLayers");
    container.innerHTML = "";
    if (!comp) {
      setText("compTemplateTiming", "节奏驱动：未选择模板");
      return;
    }
    setText("compTemplateTiming", "正在读取模板信息");
    hostCall("ae.comp.templateInfo", { compId: comp.compId }).then(function (result) {
      var info = result.data || {};
      var fragment = document.createDocumentFragment();
      (info.textLayers || []).forEach(function (layer) {
        var label = document.createElement("label");
        label.className = "picker-row";
        var input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.value = String(layer.layerId);
        input.addEventListener("change", collectCompTemplateSelection);
        var span = document.createElement("span");
        var strong = document.createElement("strong");
        strong.textContent = layer.name || ("图层 " + layer.index);
        var small = document.createElement("small");
        small.textContent = "图层 " + layer.index + " · " + Number(layer.outPoint - layer.inPoint).toFixed(1) + "s";
        span.appendChild(strong);
        span.appendChild(small);
        label.appendChild(input);
        label.appendChild(span);
        fragment.appendChild(label);
      });
      container.appendChild(fragment);
      state.compTemplate = { compId: info.compId, name: info.name, textLayerIds: (info.textLayers || []).map(function (layer) { return layer.layerId; }), progressDriver: info.progressDriver || null };
      setText("compTemplateTiming", info.progressDriver
        ? "节奏驱动：滑杆「" + info.progressDriver.effectName + "」· 每句按词级时间写进度键"
        : "未找到 LWS Progress 滑杆：将尝试动画器 Start 键，否则整行线性拉伸");
    }).catch(function (error) {
      setText("compTemplateTiming", "模板信息读取失败 · " + error.message);
    });
  }

  function collectCompTemplateSelection() {
    if (!state.compTemplate) return;
    var ids = [];
    all("#compTemplateTextLayers input[type=checkbox]").forEach(function (input) { if (input.checked) ids.push(Number(input.value)); });
    state.compTemplate.textLayerIds = ids;
  }

  function installAdaptiveGrid() {
    var shell = document.querySelector(".panel-shell");
    if (!shell) return;

    // Keep the AE template tool beside the effect tool in the first desktop
    // row.  It is declared near the output controls for accessibility, but
    // moving it before the full-width transcription section keeps the mobile
    // reading order aligned with the desktop interaction flow.
    var template = document.getElementById("templateDetails");
    var transcription = document.getElementById("transcriptionDetails");
    if (shell && template && transcription && template.parentNode === shell) shell.insertBefore(template, transcription);

    // Grid rows are sized intrinsically by the explicit desktop template in
    // panel.css.  Do not convert pixel heights into grid-row spans: a span is
    // a number of tracks, not a CSS pixel value, and doing so creates hundreds
    // of implicit one-pixel rows that overlap neighbouring panels.  Clear any
    // stale inline value left by an older panel session when the viewport
    // changes between desktop and compact layouts.
    function clearGridOverrides() {
      Array.prototype.forEach.call(shell.children, function (item) {
        item.style.gridRowEnd = "";
        item.style.gridColumnEnd = "";
      });
    }
    clearGridOverrides();
    window.addEventListener("resize", clearGridOverrides);
  }

  function initialize() {
    bindUi();
    installAdaptiveGrid();
    loadConfiguredPythonRuntime();
    loadSettings();
    updateSttVisibility();
    updatePreview();
    if (window.lucide) window.lucide.createIcons();
    var environmentHost = detectHostFromEnvironment();
    if (environmentHost) {
      // Show the correct host-specific tools immediately.  If bootstrap fails,
      // the user can still see AE's effect-copy panel and its diagnostic state.
      setHostUi(environmentHost);
      setText("hostBadge", environmentHost === "AEFT" ? "AE" : "PR");
      setText("hostLabel", environmentHost === "AEFT" ? "After Effects · 正在连接" : "Premiere Pro · 正在连接");
    }
    var bootstrapPromise = new Promise(function (resolve) {
      if (!bridge.bootstrapFromExtensionRoot) return resolve();
      bridge.bootstrapFromExtensionRoot(root, function () { resolve(); });
    });
    bootstrapPromise.then(function () { return hostCall("common.ping"); }).then(function (result) {
      setHostUi(result.data.host);
      setText("hostLabel", result.data.appName + " " + result.data.version);
      return hostCall("common.capabilities");
    }).then(function (result) {
      state.capabilities = result.data.features || {};
      applyCapabilities();
      if (state.host === "AEFT") loadCompTemplateList();
      return Promise.all([loadContext(), loadFonts()]);
    }).then(function () {
      var saved = state.settings;
      if (saved && saved.models && saved.models.length) {
        state.models = saved.models;
        detectEnvironment(state.models, function (error) {
          if (error) setStatus("error", "运行环境检测失败", error.message);
          else renderModels();
          updateReadyState();
        });
        return;
      }
      var installedModelPath = state.installedModelPath;
      if (installedModelPath) {
        scan("specifiedDirectory", installedModelPath);
        return;
      }
      if (saved && saved.scanMode === "specifiedDirectory" && saved.scanPath && fs.existsSync(saved.scanPath)) {
        scan("specifiedDirectory", saved.scanPath);
      } else {
        setStatus("warning", "请选择模型扫描方式", "指定文件夹扫描或全盘扫描");
      }
      updateReadyState();
    }).catch(function (error) {
      if (environmentHost) setHostUi(environmentHost);
      setStatus("error", "Adobe 宿主连接失败", hostErrorDetail(error) + "。请完全退出并重新打开 Adobe 后重试。");
    });
  }

  initialize();
}());
