"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const jsx = fs.readFileSync(path.resolve(__dirname, "../../extension/jsx/AEFT/correction-highlight.jsx"), "utf8");

function harness() {
  class Property {
    constructor(matchName, value) { this.matchName = matchName; this.value = value; this.keys = []; this.numProperties = 0; }
    setValue(value) { this.value = value; }
    setValueAtTime(time, value) { this.keys.push({ time, value }); }
    get numKeys() { return this.keys.length; }
    setInterpolationTypeAtKey() {}
  }
  class Group {
    constructor(matchName) { this.matchName = matchName; this.children = []; }
    get numProperties() { return this.children.length; }
    property(key) { return typeof key === "number" ? this.children[key - 1] : this.children.find((child) => child.matchName === key); }
    addProperty(name) {
      let value;
      if (name === "ADBE Text Animator") {
        value = new Group(name);
        value.children.push(new Group("ADBE Text Animator Properties"), new Group("ADBE Text Selectors"));
      } else if (name === "ADBE Text Selector") {
        value = new Group(name);
        const advanced = new Group("ADBE Text Range Advanced");
        for (const prop of ["ADBE Text Range Units", "ADBE Text Range Type2", "ADBE Text Selector Smoothness"]) advanced.children.push(new Property(prop, 100));
        value.children.push(advanced);
        for (const prop of ["ADBE Text Index Start", "ADBE Text Index End", "ADBE Text Selector Max Amount"]) value.children.push(new Property(prop, 0));
      } else value = new Property(name, null);
      value.remove = () => { this.children.splice(this.children.indexOf(value), 1); };
      this.children.push(value);
      return value;
    }
  }
  const text = new Group("ADBE Text Properties"), animators = new Group("ADBE Text Animators");
  const document = new Property("ADBE Text Document", { text: "原文修改", fillColor: [1, 0, 0], strokeColor: [0, 1, 0] });
  text.children.push(animators, document);
  const layer = { inPoint: 0, property: (name) => name === "ADBE Text Properties" ? text : null };
  const context = { $: { _LWS: {} }, KeyframeInterpolationType: { HOLD: 1 } };
  vm.runInNewContext(jsx, context);
  return { layer, animators, document, apply: context.$._LWS.applyCorrectionHighlights };
}

test("AE correction color is an added character animator and preserves template fill/stroke colors", () => {
  const h = harness(), warnings = [];
  h.apply(h.layer, [{ id: "one", rendered: { text: "原文修改", ranges: [{ start: 2, end: 4 }], color: "#0000ff" } }], false, warnings);
  assert.deepEqual(warnings, []);
  assert.deepEqual(h.document.value.fillColor, [1, 0, 0]);
  assert.deepEqual(h.document.value.strokeColor, [0, 1, 0]);
  const animator = h.animators.property(1), color = animator.property("ADBE Text Animator Properties").property("ADBE Text Fill Color").value;
  assert.deepEqual(Array.from(color), [0, 0, 1]);
  const selector = animator.property("ADBE Text Selectors").property(1);
  assert.equal(selector.property("ADBE Text Range Advanced").property("ADBE Text Range Units").value, 2);
  assert.equal(selector.property("ADBE Text Index Start").value, 2);
  assert.equal(selector.property("ADBE Text Index End").value, 4);
});

test("single-layer correction highlighting switches off outside each subtitle interval", () => {
  const h = harness(), warnings = [];
  h.apply(h.layer, [{ id: "one", startMs: 1000, endMs: 2000, rendered: { text: "原文修改", ranges: [{ start: 2, end: 4 }], color: "#ff8000" } }], true, warnings);
  const selector = h.animators.property(1).property("ADBE Text Selectors").property(1);
  assert.deepEqual(selector.property("ADBE Text Selector Max Amount").keys, [{ time: 0, value: 0 }, { time: 1, value: 100 }, { time: 2, value: 0 }]);
  assert.deepEqual(warnings, []);
});

test("unchanged STT adds no character-color animator", () => {
  const h = harness();
  h.apply(h.layer, [{ id: "one", rendered: { text: "原文", ranges: [], color: "#0000ff" } }], false, []);
  assert.equal(h.animators.numProperties, 0);
});
