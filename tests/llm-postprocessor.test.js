"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const llm = require("../extension/js/core/llm-postprocessor");
const display = require("../extension/js/core/subtitle-display");

function records() {
  return [0, 1].map((group) => ({ source: { layerId: group + 1 }, result: { sourceLanguage: { code: "en" }, segments: [
    { id: "seg-000001", startMs: 1000 + group * 2000, endMs: 1800 + group * 2000, sourceText: group ? "I want go." : "This is a peace of cake.", sourceLines: [group ? "I want go." : "This is a peace of cake."] }
  ] } }));
}

async function serverRun(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run("http://127.0.0.1:" + server.address().port + "/v1"); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function process(records, config) {
  return new Promise((resolve, reject) => llm.processRecords(records, config, "test-key", (error, result) => error ? reject(error) : resolve(result)));
}

test("all media groups use one LLM request for correction, completion and two translations with unchanged timing", async () => {
  let requests = 0;
  const data = records();
  const times = data.map((record) => [record.result.segments[0].startMs, record.result.segments[0].endMs]);
  await serverRun((req, res) => {
    requests += 1;
    let body = "";
    req.on("data", (part) => { body += part; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(req.headers.authorization, "Bearer test-key");
      assert.match(payload.messages[0].content, /NEVER polish/);
      assert.match(payload.messages[0].content, /Completion is enabled/);
      const input = JSON.parse(payload.messages[1].content);
      assert.deepEqual(input.items.map((item) => item.id), ["g0:seg-000001", "g1:seg-000001"]);
      const items = [
        { id: input.items[0].id, text: "This is a piece of cake.", translations: { en: { text: "This is a piece of cake.", changedSpans: [] }, "zh-CN": { text: "这很简单。", changedSpans: [{ text: "简单", occurrence: 1 }] } } },
        { id: input.items[1].id, text: "I want to go.", translations: { en: { text: "I want to go.", changedSpans: [] }, "zh-CN": { text: "我想要去。", changedSpans: [{ text: "要", occurrence: 1 }] } } }
      ];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: items.reverse() }) } }] }));
    });
  }, async (baseUrl) => {
    await process(data, { baseUrl, model: "test", maxCharsPerLine: 8, targetLanguages: ["en", "zh-CN"], correction: { enabled: true, allowCompletion: true, highlightColor: "#1234ff" } });
  });
  assert.equal(requests, 1);
  assert.deepEqual(data.map((record) => [record.result.segments[0].startMs, record.result.segments[0].endMs]), times);
  assert.equal(data[0].result.segments[0].originalSourceText, "This is a peace of cake.");
  assert.equal(data[0].result.segments[0].sourceText, "This is a piece of cake.");
  assert.ok(data[0].result.segments[0].translations.en.lines.length > 1);
  assert.ok(data[0].result.segments[0].translations.en.lines.every((line) => line.length <= 8));
  assert.equal(data[0].result.segments[0].translations.en.text, data[0].result.segments[0].sourceText);
  const rendered = display.renderSegment(data[0].result.segments[0], ["en", "zh-CN"]);
  assert.equal(rendered.color, "#1234ff");
  assert.ok(rendered.ranges.length >= 2);
  assert.match(display.reviewHtml(data[0].result.segments), /color:#1234ff/);
  assert.equal(JSON.stringify(data).includes("test-key"), false);
});

test("one-request policy does not retry HTTP errors and never mutates original captions on failure", async () => {
  const data = records(), original = JSON.stringify(data);
  let requests = 0;
  await serverRun((_req, res) => { requests += 1; res.statusCode = 503; res.end("{}"); }, async (baseUrl) => {
    await assert.rejects(process(data, { baseUrl, model: "test", targetLanguages: [], correction: { enabled: true } }), { code: "E_TRANSLATION_HTTP" });
  });
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(data), original);
});

test("malformed IDs or missing translations reject the complete reply without partial updates", async () => {
  const data = records(), original = JSON.stringify(data);
  await serverRun((req, res) => { req.resume(); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ id: "wrong", text: "Anything", translations: {} }] }) } }] })); }, async (baseUrl) => {
    await assert.rejects(process(data, { baseUrl, model: "test", targetLanguages: [], correction: { enabled: true } }), { code: "E_CORRECTION_RESPONSE_INVALID" });
  });
  assert.equal(JSON.stringify(data), original);
});

test("source-only correction works without translation targets and includes no completion when disabled", () => {
  const data = records(), config = { correction: { enabled: true, allowCompletion: false }, targetLanguages: [] };
  const request = llm.buildRequest(data, config);
  assert.match(request.body.messages[0].content, /Completion is disabled/);
  assert.match(request.body.messages[0].content, /complete final texts, not patches/);
  const output = llm.validateResponse(request.items, { items: request.items.map((item) => ({ id: item.id, text: item.text.replace("peace", "piece"), translations: {} })) }, config);
  assert.equal(output[0].text, "This is a piece of cake.");
});

test("character diff colors only inserted/replaced characters and keeps emoji boundaries intact", () => {
  assert.deepEqual(llm.changedRanges("原文。", "原文。"), []);
  assert.deepEqual(llm.changedRanges("I go.", "I will go."), [{ start: 2, end: 7 }]);
  assert.deepEqual(llm.changedRanges("中😀文", "中🚀文"), [{ start: 1, end: 3 }]);
  const text = "I want to go.", ranges = llm.changedRanges("I want go.", text);
  assert.deepEqual(ranges.map((range) => text.slice(range.start, range.end)), ["to "]);
});

test("wrapping and bilingual layout remap highlight offsets and HTML escapes subtitle content", () => {
  const segment = { sourceText: "hello world", sourceLines: ["hello", "world"], correction: { ranges: [{ start: 6, end: 11 }], color: "#0000ff" }, translations: { zh: { text: "你好世界", lines: ["你好", "世界"], highlightRanges: [{ start: 2, end: 4 }] } } };
  const rendered = display.renderSegment(segment, ["source", "zh"]);
  assert.equal(rendered.text, "hello\nworld\n你好\n世界");
  assert.deepEqual(rendered.ranges.map((range) => rendered.text.slice(range.start, range.end)), ["world", "世界"]);
  assert.doesNotMatch(display.coloredText({ text: "<script>", ranges: [], color: "#0000ff" }, "html"), /<script>/);
});

test("canceling the single LLM request stops it and leaves the STT output unchanged", async () => {
  const data = records(), original = JSON.stringify(data);
  await serverRun((_req, _res) => {}, async (baseUrl) => {
    const error = await new Promise((resolve) => {
      const controller = llm.processRecords(data, { baseUrl, model: "test", targetLanguages: [], correction: { enabled: true } }, "key", resolve);
      controller.cancel();
    });
    assert.equal(error.code, "E_JOB_CANCELED");
  });
  assert.equal(JSON.stringify(data), original);
});
