"use strict";

function checkedRanges(text, ranges) {
  if (!Array.isArray(ranges)) throw new Error("标色范围必须是数组");
  var previousEnd = 0;
  return ranges.map(function (range) {
    if (!range || typeof range.start !== "number" || typeof range.end !== "number" || Math.floor(range.start) !== range.start || Math.floor(range.end) !== range.end || range.start < previousEnd || range.end <= range.start || range.end > text.length) throw new Error("标色范围无效或重叠");
    previousEnd = range.end;
    return { start: range.start, end: range.end };
  });
}

// Wrapping changes only whitespace. Remap UTF-16 offsets onto the displayed
// string so highlights stay on the same characters after inserted newlines.
function mapRanges(text, displayed, ranges) {
  var map = [], sourceIndex = 0;
  for (var i = 0; i < displayed.length; i += 1) {
    var character = displayed.charAt(i);
    while (sourceIndex < text.length && /\s/.test(text.charAt(sourceIndex)) && text.charAt(sourceIndex) !== character) sourceIndex += 1;
    if (text.charAt(sourceIndex) === character) { map[i] = sourceIndex; sourceIndex += 1; }
    else map[i] = null;
  }
  var output = [], start = null;
  for (i = 0; i <= displayed.length; i += 1) {
    var selected = i < displayed.length && map[i] !== null && ranges.some(function (range) { return map[i] >= range.start && map[i] < range.end; });
    if (selected && start === null) start = i;
    if (!selected && start !== null) { output.push({ start: start, end: i }); start = null; }
  }
  return output;
}

function renderSegment(segment, languages) {
  var text = "", ranges = [];
  (languages && languages.length ? languages : ["source"]).forEach(function (language, index) {
    var item = language !== "source" && segment.translations && segment.translations[language];
    var value = item ? item.text : segment.sourceText;
    var lines = item ? item.lines : segment.sourceLines;
    var highlights = item ? (item.highlightRanges || []) : (segment.correction && segment.correction.ranges || []);
    var displayed = lines && lines.length ? lines.join("\n") : value;
    if (index) text += "\n";
    var offset = text.length;
    mapRanges(value, displayed, highlights).forEach(function (range) { ranges.push({ start: offset + range.start, end: offset + range.end }); });
    text += displayed;
  });
  return { text: text, ranges: ranges, color: segment.correction && segment.correction.color || "#0000ff" };
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function coloredText(rendered, tag) {
  var ranges = checkedRanges(rendered.text, rendered.ranges || []);
  var color = /^#[0-9a-f]{6}$/i.test(rendered.color) ? rendered.color : "#0000ff";
  var text = "", cursor = 0;
  ranges.forEach(function (range) {
    text += escapeHtml(rendered.text.slice(cursor, range.start));
    text += tag === "html" ? '<span style="color:' + color + '">' : '<font color="' + color + '">';
    text += escapeHtml(rendered.text.slice(range.start, range.end));
    text += tag === "html" ? "</span>" : "</font>";
    cursor = range.end;
  });
  return text + escapeHtml(rendered.text.slice(cursor));
}

function reviewHtml(segments) {
  return '<!doctype html><meta charset="utf-8"><title>字幕纠错核对</title><style>body{background:#202124;color:#eee;font:18px sans-serif;margin:24px}section{margin:24px 0}small{color:#aaa}p{white-space:pre-wrap}</style><h1>字幕纠错核对</h1>' + segments.map(function (segment) {
    return '<section><small>' + segment.startMs + ' → ' + segment.endMs + ' ms · STT 原文</small><p>' + escapeHtml(segment.originalSourceText || segment.sourceText) + '</p><small>输出字幕（有色部分为纠正或补全）</small><p>' + coloredText(segment.rendered || renderSegment(segment, segment.displayLanguages), "html") + '</p></section>';
  }).join("");
}

module.exports = { renderSegment: renderSegment, checkedRanges: checkedRanges, coloredText: coloredText, reviewHtml: reviewHtml };
