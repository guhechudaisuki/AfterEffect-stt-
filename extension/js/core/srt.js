"use strict";

function pad(value, size) {
  var text = String(Math.max(0, Math.floor(value)));
  while (text.length < size) text = "0" + text;
  return text;
}

function formatTime(ms) {
  ms = Math.max(0, Math.round(ms));
  var hours = Math.floor(ms / 3600000);
  ms -= hours * 3600000;
  var minutes = Math.floor(ms / 60000);
  ms -= minutes * 60000;
  var seconds = Math.floor(ms / 1000);
  var millis = ms - seconds * 1000;
  return pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2) + "," + pad(millis, 3);
}

function escapeText(text) {
  return String(text || "").replace(/\r?\n/g, "\n").replace(/\u0000/g, "");
}

function toSrt(segments, language) {
  var blocks = [];
  var ordinal = 1;
  (segments || []).forEach(function (segment) {
    var item = language && segment.translations && segment.translations[language] || null;
    var text = item && (Array.isArray(item.lines) ? item.lines.join("\n") : item.text) || (Array.isArray(segment.sourceLines) ? segment.sourceLines.join("\n") : segment.sourceText || "");
    if (language && segment.translations && segment.translations[language]) {
      text = item && (Array.isArray(item.lines) ? item.lines.join("\n") : item.text) || text;
    }
    if (!text.trim()) return;
    blocks.push(String(ordinal++) + "\r\n" + formatTime(segment.startMs) + " --> " + formatTime(segment.endMs) + "\r\n" + escapeText(text) + "\r\n");
  });
  return "\uFEFF" + blocks.join("\r\n");
}

module.exports = { formatTime: formatTime, toSrt: toSrt };
