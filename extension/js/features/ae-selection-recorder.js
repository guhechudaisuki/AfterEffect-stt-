"use strict";

function SelectionRecorder(bridge, options) {
  this.bridge = bridge;
  this.options = options || {};
  this.intervalMs = this.options.intervalMs || 200;
  this.recorded = [];
  this.previous = {};
  this.compId = null;
  this.timer = null;
  this.recording = false;
  this.busy = false;
}

SelectionRecorder.prototype.start = function (callback) {
  var self = this;
  this.stop();
  this.recorded = [];
  this.previous = {};
  this.compId = null;
  this.recording = true;
  this.poll(function (error) {
    if (error) { self.stop(); return callback && callback(error); }
    self.timer = setInterval(function () { self.poll(); }, self.intervalMs);
    if (callback) callback(null, self.getItems());
  });
};

SelectionRecorder.prototype.stop = function () {
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
  this.recording = false;
  this.busy = false;
  return this.getItems();
};

SelectionRecorder.prototype.poll = function (callback) {
  var self = this;
  if (!this.recording || this.busy) return;
  this.busy = true;
  this.bridge.call("ae.selection.snapshot", {}, function (error, snapshot) {
    self.busy = false;
    if (error) { if (callback) callback(error); if (self.options.onError) self.options.onError(error); return; }
    if (self.compId !== null && self.compId !== snapshot.compId) {
      var compError = new Error("记录期间活动合成发生变化");
      compError.code = "AE_SELECTION_COMP_CHANGED";
      self.stop();
      if (callback) callback(compError);
      if (self.options.onError) self.options.onError(compError);
      return;
    }
    self.compId = snapshot.compId;
    var current = {};
    var added = [];
    (snapshot.layers || []).forEach(function (layer) {
      current[layer.layerId] = true;
      if (!self.previous[layer.layerId] && (!self.options.textOnly || layer.isText)) added.push(layer);
    });
    added.sort(function (a, b) { return a.index - b.index; });
    added.forEach(function (layer) {
      self.recorded = self.recorded.filter(function (item) { return item.layerId !== layer.layerId || item.compId !== layer.compId; });
      self.recorded.push(layer);
    });
    self.previous = current;
    if (added.length && self.options.onUpdate) self.options.onUpdate(self.getItems());
    if (callback) callback(null, self.getItems());
  });
};

SelectionRecorder.prototype.getItems = function () { return this.recorded.slice(); };

SelectionRecorder.prototype.move = function (fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= this.recorded.length || toIndex < 0 || toIndex >= this.recorded.length) return this.getItems();
  var item = this.recorded.splice(fromIndex, 1)[0];
  this.recorded.splice(toIndex, 0, item);
  if (this.options.onUpdate) this.options.onUpdate(this.getItems());
  return this.getItems();
};

SelectionRecorder.prototype.setItems = function (items) {
  this.recorded = (items || []).slice();
  if (this.options.onUpdate) this.options.onUpdate(this.getItems());
};

module.exports = SelectionRecorder;
