"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var SelectionRecorder = require("../extension/js/features/ae-selection-recorder");

function FakeBridge(snapshots) { this.snapshots = snapshots.slice(); }
FakeBridge.prototype.call = function (_, __, callback) { callback(null, this.snapshots.shift() || { compId: 1, layers: [] }); };

test("selection recorder preserves transition order and moves reselected layer to the end", function () {
  var bridge = new FakeBridge([
    { compId: 1, layers: [{ compId: 1, layerId: 10, index: 3, name: "A", isText: true }] },
    { compId: 1, layers: [{ compId: 1, layerId: 20, index: 1, name: "B", isText: true }] },
    { compId: 1, layers: [] },
    { compId: 1, layers: [{ compId: 1, layerId: 10, index: 3, name: "A", isText: true }] }
  ]);
  var recorder = new SelectionRecorder(bridge, { textOnly: true });
  recorder.recording = true;
  recorder.poll(); recorder.poll(); recorder.poll(); recorder.poll();
  assert.deepEqual(recorder.getItems().map(function (item) { return item.layerId; }), [20, 10]);
  recorder.stop();
});

test("selection recorder appends same-poll multi-select by stack order", function () {
  var bridge = new FakeBridge([{ compId: 1, layers: [{ compId: 1, layerId: 2, index: 5, isText: true }, { compId: 1, layerId: 1, index: 2, isText: true }] }]);
  var recorder = new SelectionRecorder(bridge, { textOnly: true });
  recorder.recording = true;
  recorder.poll();
  assert.deepEqual(recorder.getItems().map(function (item) { return item.layerId; }), [1, 2]);
});
