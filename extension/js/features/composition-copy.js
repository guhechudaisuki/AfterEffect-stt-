"use strict";

var SelectionRecorder = require("./ae-selection-recorder");

module.exports = function createCompositionCopy(options) {
  var document = options.document;
  var host = "unknown";
  var applying = false;
  var loadingList = false;
  var loadingTemplate = false;
  var stopping = false;
  var requestVersion = 0;
  var template = null;
  var inFlightSnapshot = null;
  var recordButton = byId("recordCompositionSourcesButton");
  var sourceList = byId("compositionSourceList");
  var templateSelect = byId("compositionTemplateSelect");
  var templateLayers = byId("compositionTemplateLayers");
  var copyButton = byId("copyCompositionButton");
  var recorder = new SelectionRecorder({ call: function (route, params, callback) {
    var finish;
    var pending = new Promise(function (resolve) { finish = resolve; });
    inFlightSnapshot = pending;
    options.bridge.call("ae.comp.copy.snapshot", params, function (error, snapshot) {
      try { callback(error, snapshot); }
      finally {
        if (inFlightSnapshot === pending) inFlightSnapshot = null;
        finish();
      }
    });
  } }, { textOnly: true, onUpdate: renderSources, onError: function (error) {
    recorder.stop();
    reportError("来源记录已停止", error);
    refresh();
  } });

  function byId(id) { return document.getElementById(id); }
  function reportError(title, error) { options.setStatus("error", title, error.message || String(error)); }
  function operationLocked() { return host !== "AEFT" || applying || loadingList || stopping || !!(options.isBusy && options.isBusy()); }
  function controlsLocked() { return operationLocked() || recorder.recording; }
  function empty(container, message) {
    container.innerHTML = "";
    var row = document.createElement(container === sourceList ? "li" : "p");
    row.className = "empty-row";
    row.textContent = message;
    container.appendChild(row);
  }

  function refresh() {
    byId("compositionCopyDetails").hidden = host !== "AEFT";
    recordButton.disabled = operationLocked() || loadingTemplate;
    recordButton.classList.toggle("recording", recorder.recording);
    recordButton.setAttribute("aria-pressed", recorder.recording ? "true" : "false");
    recordButton.querySelector("span").textContent = stopping ? "正在结束记录…" : (recorder.recording ? "结束记录" : "记录来源文字图层");
    byId("chooseCompositionAepButton").disabled = controlsLocked();
    byId("refreshCompositionTemplatesButton").disabled = controlsLocked();
    templateSelect.disabled = controlsLocked();
    var items = recorder.getItems();
    copyButton.disabled = controlsLocked() || loadingTemplate || !items.length || recorder.compId === null || !template || !template.textLayers.length;
    Array.prototype.forEach.call(sourceList.querySelectorAll("button"), function (button) {
      button.disabled = controlsLocked() || button.dataset.boundary === "true";
    });
    if (template && items.length) {
      byId("compositionCopyHint").textContent = items.length + " 个来源文字层 → 每个合成 " + template.textLayers.length + " 个文字层 → " + Math.ceil(items.length / template.textLayers.length) + " 个合成副本；末批未对应的文字层保留模板内容。";
    }
  }

  function renderSources() {
    var items = recorder.getItems();
    sourceList.innerHTML = "";
    if (!items.length) empty(sourceList, "依次点击来源文字图层，再次点击结束记录");
    items.forEach(function (item, index) {
      var row = document.createElement("li");
      var order = document.createElement("b");
      order.textContent = String(index + 1);
      var name = document.createElement("span");
      name.textContent = item.name || "文字图层";
      name.title = name.textContent;
      row.appendChild(order);
      row.appendChild(name);
      [-1, 1].forEach(function (direction) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "icon-button";
        button.textContent = direction < 0 ? "↑" : "↓";
        button.setAttribute("aria-label", (direction < 0 ? "上移 " : "下移 ") + name.textContent);
        button.dataset.boundary = String(index + direction < 0 || index + direction >= items.length);
        button.addEventListener("click", function () {
          if (!controlsLocked()) recorder.move(index, index + direction);
        });
        row.appendChild(button);
      });
      sourceList.appendChild(row);
    });
    refresh();
  }

  function clearRecorderTimer() {
    if (recorder.timer) clearInterval(recorder.timer);
    recorder.timer = null;
  }

  function stopRecording() {
    stopping = true;
    clearRecorderTimer();
    refresh();
    // A pending poll must finish before the final snapshot. Keep recording
    // enabled until both callbacks have been consumed by SelectionRecorder.
    return (inFlightSnapshot || Promise.resolve()).then(function () {
      clearRecorderTimer();
      if (!recorder.recording) return;
      return new Promise(function (resolve) { recorder.poll(function () { resolve(); }); });
    }).then(function () {
      recorder.stop();
      stopping = false;
      renderSources();
    });
  }

  function clearTemplate(message) {
    template = null;
    empty(templateLayers, message || "选择模板后显示全部文字图层");
    byId("compositionCopyHint").textContent = "来源按记录顺序，模板文字层按图层顺序，每批复制一个完整合成；不足一批时只替换对应文字层。";
  }

  function setPlaceholder(message) {
    templateSelect.innerHTML = "";
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = message;
    templateSelect.appendChild(placeholder);
    templateSelect.value = "";
  }

  function showTemplates(result) {
    var comps = result.data && result.data.comps || [];
    setPlaceholder(comps.length ? "请选择合成" : "没有找到包含文字图层的合成");
    comps.forEach(function (comp) {
      var option = document.createElement("option");
      option.value = String(comp.compId);
      option.textContent = comp.name + " · " + comp.textLayerCount + " 个文字层";
      templateSelect.appendChild(option);
    });
  }

  function loadTemplates(aepPath) {
    if (controlsLocked()) return Promise.resolve();
    var version = ++requestVersion;
    loadingList = true;
    loadingTemplate = false;
    clearTemplate();
    setPlaceholder(aepPath ? "正在读取 AEP…" : "正在读取项目合成…");
    refresh();
    var request = aepPath ? options.hostCall("ae.aep.import", { path: aepPath }).then(function (result) {
      return options.hostCall("ae.comp.copy.list", { compIds: (result.data.comps || []).map(function (comp) { return comp.compId; }) });
    }) : options.hostCall("ae.comp.copy.list", {});
    return request.then(function (result) {
      if (version === requestVersion) showTemplates(result);
    }).catch(function (error) {
      if (version !== requestVersion) return;
      setPlaceholder("合成列表读取失败");
      reportError("合成列表读取失败", error);
    }).then(function () {
      if (version === requestVersion) { loadingList = false; refresh(); }
    });
  }

  function selectTemplate() {
    if (controlsLocked()) return;
    var compId = templateSelect.value;
    var version = ++requestVersion;
    loadingTemplate = !!compId;
    clearTemplate(compId ? "正在读取文字图层…" : null);
    refresh();
    if (!compId) return;
    options.hostCall("ae.comp.copy.info", { compId: Number(compId) }).then(function (result) {
      if (version !== requestVersion) return;
      var info = result.data;
      if (!info || !info.textLayers || !info.textLayers.length || !info.signature) throw new Error("模板没有可替换文字图层，请重新读取合成");
      template = info;
      templateLayers.innerHTML = "";
      info.textLayers.forEach(function (layer, index) {
        var row = document.createElement("div");
        row.className = "composition-template-row";
        var name = document.createElement("strong");
        name.textContent = (index + 1) + " · " + layer.name;
        var detail = document.createElement("small");
        detail.textContent = (layer.path instanceof Array ? layer.path.join(" / ") : String(layer.path || "")) + (layer.text === null ? "" : " · " + String(layer.text || ""));
        row.appendChild(name);
        row.appendChild(detail);
        templateLayers.appendChild(row);
      });
    }).catch(function (error) {
      if (version !== requestVersion) return;
      clearTemplate("文字图层读取失败");
      reportError("模板读取失败", error);
    }).then(function () {
      if (version === requestVersion) { loadingTemplate = false; refresh(); }
    });
  }

  function copyComposition() {
    refresh();
    if (copyButton.disabled) return;
    applying = true;
    refresh();
    options.setStatus("loading", "正在复制合成", "按来源顺序分批替换模板文字");
    options.hostCall("ae.comp.copy.create", {
      sourceCompId: recorder.compId,
      targetCompId: recorder.compId,
      sourceLayerIds: recorder.getItems().map(function (item) { return item.layerId; }),
      templateCompId: template.compId,
      templateSignature: template.signature
    }).then(function (result) {
      var warnings = result.envelope && result.envelope.warnings || result.warnings || [];
      options.setStatus(warnings.length ? "warning" : "ready", "合成复制完成", result.data.sourceTextCount + " 个来源文字层 → " + result.data.count + " 个合成副本" + (warnings.length ? " · " + (warnings[0].message || warnings[0].code) : ""));
    }).catch(function (error) { reportError("合成复制失败", error); }).then(function () {
      applying = false;
      refresh();
    });
  }

  recordButton.addEventListener("click", function () {
    if (operationLocked() || loadingTemplate) return;
    if (recorder.recording) stopRecording();
    else { recorder.start(); renderSources(); }
  });
  byId("refreshCompositionTemplatesButton").addEventListener("click", function () { loadTemplates(); });
  byId("chooseCompositionAepButton").addEventListener("click", function () {
    if (controlsLocked()) return;
    var selected = options.choosePath(false, "选择合成复制模板 AEP", ["aep", "aet"]);
    if (selected) loadTemplates(selected);
  });
  templateSelect.addEventListener("change", selectTemplate);
  copyButton.addEventListener("click", copyComposition);
  refresh();
  return {
    setHost: function (value) { host = value; refresh(); },
    refresh: refresh,
    loadTemplates: function () { return loadTemplates(); },
    destroy: function () { requestVersion += 1; recorder.stop(); }
  };
};
