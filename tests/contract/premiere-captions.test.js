const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workspace = path.resolve(__dirname, "../..");
const jsxRoot = path.join(workspace, "extension/jsx");

function loadSource(relativePath) {
  return fs.readFileSync(path.join(jsxRoot, relativePath), "utf8");
}

function createContext(version, withCaptionApi) {
  const importedItem = { nodeId: "srt-1" };
  const children = { numItems: 0 };
  const bin = { children };
  const sequence = {
    sequenceID: "sequence-1",
    getSettings() { return { videoFrameWidth: 1920, videoFrameHeight: 1080 }; }
  };
  if (withCaptionApi) {
    sequence.createCaptionTrack = function (projectItem, startAtTime) {
      sequence.captionCall = { projectItem, startAtTime };
      return true;
    };
  }
  const context = {
    $: {},
    app: {
      version,
      name: "Adobe Premiere Pro",
      project: {
        activeSequence: sequence,
        rootItem: bin,
        importFiles() {
          children[0] = importedItem;
          children.numItems = 1;
          return true;
        }
      }
    },
    BridgeTalk: { appName: "premierepro" },
    File: function (filePath) { this.fsName = filePath; this.exists = true; },
    JSON,
    Date,
    Error,
    Math,
    Number,
    Object,
    String,
    decodeURIComponent,
    encodeURIComponent,
    isFinite
  };
  vm.runInNewContext(loadSource("common/response.jsx"), context, { filename: "response.jsx" });
  vm.runInNewContext(loadSource("PPRO/host.jsx"), context, { filename: "PPRO/host.jsx" });
  return { context, sequence };
}

function callCaptionRoute(context) {
  const request = encodeURIComponent(JSON.stringify({
    apiVersion: "1.0",
    requestId: "captions-1",
    params: { srtPath: "C:\\temp\\captions.srt", startSeconds: 2.5 }
  }));
  return JSON.parse(context.$._LWS.dispatch("pr.subtitles.captions.create", request));
}

test("Premiere Pro 23+ imports SRT and creates a native caption track", () => {
  const fixture = createContext("23.0.0", true);
  const response = callCaptionRoute(fixture.context);
  assert.equal(response.ok, true);
  assert.equal(response.data.created, true);
  assert.equal(response.data.requiresManualPlacement, false);
  assert.equal(fixture.sequence.captionCall.projectItem.nodeId, "srt-1");
  assert.equal(fixture.sequence.captionCall.startAtTime, 2.5);
});

test("Premiere Pro 2020 imports SRT and reports manual placement when caption API is unavailable", () => {
  const fixture = createContext("14.0.0", false);
  const response = callCaptionRoute(fixture.context);
  assert.equal(response.ok, true);
  assert.equal(response.data.created, false);
  assert.equal(response.data.imported, true);
  assert.equal(response.data.requiresManualPlacement, true);
  assert.equal(response.warnings[0].code, "PR_CAPTION_API_UNAVAILABLE");
});
