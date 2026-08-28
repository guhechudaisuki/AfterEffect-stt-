"use strict";

var closingMarks = "\"'”’》」』】)]}〉〕»";
var openingMarks = "\"'“‘《「『【([{〈〔«";
var weakPunctuation = /[,，、；;：:]/;
var abbreviation = /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|No|e\.g|i\.e|[A-Za-z](?:\.[A-Za-z])+?)\.$/i;

function cleanText(text) {
  return String(text || "").replace(/[\r\n]+/g, " ").replace(/[ \t]+/g, " ").trim();
}

function number(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

function isCombining(code) {
  return code >= 0x0300 && code <= 0x036f || code >= 0x1ab0 && code <= 0x1aff ||
    code >= 0x1dc0 && code <= 0x1dff || code >= 0xfe20 && code <= 0xfe2f ||
    code >= 0xfe00 && code <= 0xfe0f || code >= 0x1f3fb && code <= 0x1f3ff;
}

function codePoint(value, index) {
  var first = value.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
    var second = value.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { text: value.slice(index, index + 2), code: (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000, length: 2 };
    }
  }
  return { text: value.charAt(index), code: first, length: 1 };
}

function countGraphemes(text) {
  var value = String(text || "");
  var output = [];
  var joinNext = false;
  var regionalPending = false;
  var index = 0;
  while (index < value.length) {
    var point = codePoint(value, index);
    index += point.length;
    var regional = point.code >= 0x1f1e6 && point.code <= 0x1f1ff;
    if (!output.length) {
      output.push(point.text);
      regionalPending = regional;
      continue;
    }
    if (isCombining(point.code) || point.code === 0x200d || joinNext || regional && regionalPending) {
      output[output.length - 1] += point.text;
    } else {
      output.push(point.text);
    }
    joinNext = point.code === 0x200d;
    if (regional) regionalPending = !regionalPending;
    else if (point.code !== 0x200d && !isCombining(point.code)) regionalPending = false;
  }
  return output;
}

function normalizeWords(words, minimumMs, maximumMs) {
  if (!Array.isArray(words)) return [];
  var minimum = number(minimumMs, 0);
  var maximum = number(maximumMs, Number.MAX_VALUE);
  var previousEnd = minimum;
  return words.map(function (word, index) {
    var start = Math.round(number(word.startMs, number(word.start, 0) * 1000));
    var end = Math.round(number(word.endMs, number(word.end, start / 1000) * 1000));
    start = Math.max(minimum, Math.min(maximum, start));
    start = Math.max(start, previousEnd);
    end = Math.max(start, Math.min(maximum, end));
    previousEnd = end;
    return {
      id: word.id || "w-" + index,
      text: String(word.text || word.word || ""),
      startMs: start,
      endMs: end,
      probability: number(word.probability, number(word.p, null)),
      vadRegionId: word.vadRegionId || null
    };
  }).filter(function (word) { return word.text && word.endMs >= word.startMs; }).sort(function (a, b) {
    return a.startMs - b.startMs || a.endMs - b.endMs;
  });
}

function isClosingMark(character) { return closingMarks.indexOf(character) >= 0; }
function isOpeningMark(character) { return openingMarks.indexOf(character) >= 0; }

function stripClosingMarks(text) {
  var value = String(text || "").trim();
  while (value && isClosingMark(value.charAt(value.length - 1))) value = value.slice(0, -1).trim();
  return value;
}

function isStrongEnd(text) {
  var value = stripClosingMarks(text);
  if (!value || abbreviation.test(value)) return false;
  var last = value.charAt(value.length - 1);
  return last === "." || last === "?" || last === "!" || last === "。" || last === "？" || last === "！" || last === "؟" || last === "…";
}

function isWeakEnd(text) {
  var value = stripClosingMarks(text);
  return value ? weakPunctuation.test(value.charAt(value.length - 1)) : false;
}

function percentile(values, p) {
  if (!values.length) return 0;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var index = (sorted.length - 1) * p;
  var lower = Math.floor(index);
  var upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function pauseThresholds(words, options) {
  options = options || {};
  var gaps = [];
  for (var i = 1; i < words.length; i += 1) {
    var gap = words[i].startMs - words[i - 1].endMs;
    if (gap >= 0) gaps.push(gap);
  }
  var median = percentile(gaps, 0.5);
  if (!median) median = 350;
  var upper = percentile(gaps, 0.8) || median;
  var soft = number(options.pauseSoftMs, Math.max(420, Math.min(850, Math.max(median * 1.65, upper))));
  var hard = number(options.pauseHardMs, Math.max(900, Math.min(1600, Math.max(median * 3.1, upper * 1.6))));
  if (hard <= soft) hard = soft + 250;
  return { softMs: Math.round(soft), hardMs: Math.round(hard) };
}

function inVadBoundary(word, nextWord, vadRegions, minimumGapMs) {
  if (!nextWord) return false;
  if (word.vadRegionId && nextWord.vadRegionId && word.vadRegionId !== nextWord.vadRegionId) return true;
  if (!Array.isArray(vadRegions) || !vadRegions.length) return false;
  var gap = Math.max(0, nextWord.startMs - word.endMs);
  if (gap < Math.max(0, number(minimumGapMs, 180))) return false;
  var currentCenter = (word.startMs + word.endMs) / 2;
  var nextCenter = (nextWord.startMs + nextWord.endMs) / 2;
  var currentRegion = -1;
  var nextRegion = -1;
  vadRegions.forEach(function (region, index) {
    var regionStart = Math.round(number(region.startMs, number(region.start, 0) * 1000));
    var regionEnd = Math.round(number(region.endMs, number(region.end, 0) * 1000));
    if (currentCenter >= regionStart && currentCenter <= regionEnd) currentRegion = index;
    if (nextCenter >= regionStart && nextCenter <= regionEnd) nextRegion = index;
  });
  if (currentRegion >= 0 && nextRegion >= 0 && currentRegion !== nextRegion) return true;
  return vadRegions.some(function (region) {
    var regionEnd = Math.round(number(region.endMs, number(region.end, 0) * 1000));
    return word.endMs >= regionEnd - 20 && nextWord.startMs > regionEnd + 20;
  });
}

function falsePeriodBoundary(current, next) {
  var value = stripClosingMarks(current && current.text);
  if (!/\.$/.test(value)) return false;
  if (abbreviation.test(value)) return true;
  if (!next) return false;
  var nextRaw = String(next.text || "");
  var nextValue = nextRaw.trim();
  var previous = value.charAt(value.length - 2);
  var following = nextValue.charAt(0);
  if (!/^\s/.test(nextRaw) && /[0-9]/.test(previous) && /[0-9]/.test(following)) return true;
  if (!/^\s/.test(nextRaw) && /[A-Za-z0-9]/.test(previous) && /^[a-z]{2,24}(?:\W|$)/.test(nextValue)) return true;
  return false;
}

function onlyClosingMarks(text) {
  var chars = countGraphemes(String(text || "").trim());
  return chars.length > 0 && chars.every(function (character) { return isClosingMark(character); });
}

function isCjk(character) {
  return /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(character || "");
}

function joinWordTexts(words) {
  var result = "";
  (words || []).forEach(function (word) {
    var raw = String(word.text || "");
    var value = raw.trim();
    if (!value) return;
    if (!result) { result = value; return; }
    var previous = result.charAt(result.length - 1);
    var first = value.charAt(0);
    var needsSpace = /^\s/.test(raw) || (!isCjk(previous) && !isCjk(first) && !/^[,.;:!?，。！？；：、…\)\]\}”’]/.test(first) && !isOpeningMark(previous));
    result += needsSpace ? " " + value : value;
  });
  return cleanText(result).replace(/\s+([,.;:!?，。！？；：、…\)\]\}”’])/g, "$1");
}

function splitTextSentences(text) {
  var chars = countGraphemes(cleanText(text));
  var parts = [];
  var start = 0;
  var index = 0;
  while (index < chars.length) {
    var character = chars[index];
    var strong = character === "。" || character === "？" || character === "！" || character === "?" || character === "!" || character === "؟" || character === "…" || character === ".";
    if (!strong) { index += 1; continue; }
    if (character === ".") {
      var previous = index > 0 ? chars[index - 1] : "";
      var next = index + 1 < chars.length ? chars[index + 1] : "";
      var currentText = chars.slice(start, index + 1).join("");
      if (/[0-9]/.test(previous) && /[0-9]/.test(next) || abbreviation.test(currentText) || /[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next)) {
        index += 1;
        continue;
      }
    }
    var end = index + 1;
    while (end < chars.length && (chars[end] === character || character === "." && chars[end] === "." || isClosingMark(chars[end]))) end += 1;
    var part = cleanText(chars.slice(start, end).join(""));
    if (part) parts.push(part);
    start = end;
    index = end;
  }
  var remainder = cleanText(chars.slice(start).join(""));
  if (remainder) parts.push(remainder);
  if (!parts.length && cleanText(text)) parts.push(cleanText(text));
  return parts;
}

function estimatedCues(raw) {
  var parts = splitTextSentences(raw.text);
  var totalWeight = parts.reduce(function (sum, part) { return sum + Math.max(1, countGraphemes(part.replace(/\s/g, "")).length); }, 0) || 1;
  var duration = Math.max(0, raw.endMs - raw.startMs);
  var cursor = raw.startMs;
  return parts.map(function (part, index) {
    var weight = Math.max(1, countGraphemes(part.replace(/\s/g, "")).length);
    var end = index === parts.length - 1 ? raw.endMs : cursor + duration * weight / totalWeight;
    var cue = {
      sourceSegmentIds: [raw.id],
      relativeStartMs: Math.round(cursor),
      relativeEndMs: Math.round(end),
      sourceText: part,
      words: [],
      timingSource: "estimated",
      boundaryReason: "estimatedPunctuation",
      warnings: [{ code: "W_TIMING_ESTIMATED" }]
    };
    cursor = end;
    return cue;
  });
}

function splitWords(words, raw, vadRegions, options) {
  var boundaries = [];
  var threshold = pauseThresholds(words, options);
  var sentenceStart = 0;
  var maxSentenceChars = number(options.maxSentenceChars, 160);
  var maxSentenceDurationMs = number(options.maxSentenceDurationMs, 15000);
  var index = 0;
  while (index < words.length) {
    var current = words[index];
    var next = words[index + 1];
    if (!next) {
      boundaries.push({ index: index, reason: "end" });
      break;
    }
    var gap = Math.max(0, next.startMs - current.endMs);
    var reason = null;
    if (inVadBoundary(current, next, vadRegions, options.vadBoundaryMinGapMs)) reason = "vad";
    else if (isStrongEnd(current.text) && !falsePeriodBoundary(current, next)) reason = "punctuation";
    else if (gap >= threshold.hardMs) reason = "hardPause";
    else if (isWeakEnd(current.text) && gap >= threshold.softMs) reason = "softPause";
    else {
      var sentenceWords = words.slice(sentenceStart, index + 1);
      if (countGraphemes(joinWordTexts(sentenceWords)).length >= maxSentenceChars || current.endMs - words[sentenceStart].startMs >= maxSentenceDurationMs) reason = "safetyLimit";
    }
    if (reason) {
      var boundaryIndex = index;
      if (reason === "punctuation") {
        while (boundaryIndex + 1 < words.length && onlyClosingMarks(words[boundaryIndex + 1].text)) boundaryIndex += 1;
      }
      boundaries.push({ index: boundaryIndex, reason: reason });
      sentenceStart = boundaryIndex + 1;
      index = boundaryIndex;
    }
    index += 1;
  }
  var cues = [];
  var start = 0;
  boundaries.forEach(function (boundary) {
    var group = words.slice(start, boundary.index + 1);
    start = boundary.index + 1;
    if (!group.length) return;
    var text = joinWordTexts(group);
    if (!text) return;
    cues.push({
      sourceSegmentIds: [raw.id],
      relativeStartMs: group[0].startMs,
      relativeEndMs: group[group.length - 1].endMs,
      sourceText: text,
      words: group,
      timingSource: "wordTimestamp",
      boundaryReason: boundary.reason,
      warnings: []
    });
  });
  return cues;
}

function normalizeRawSegments(rawSegments, maximumMs) {
  var maximum = number(maximumMs, Number.MAX_VALUE);
  return (rawSegments || []).map(function (raw, index) {
    var startMs = Math.round(number(raw.startMs, number(raw.start, 0) * 1000));
    var endMs = Math.round(number(raw.endMs, number(raw.end, startMs / 1000) * 1000));
    startMs = Math.max(0, Math.min(maximum, startMs));
    endMs = Math.max(startMs, Math.min(maximum, endMs));
    return {
      id: raw.id || "raw-" + index,
      startMs: startMs,
      endMs: endMs,
      text: cleanText(raw.text),
      words: normalizeWords(raw.words, startMs, endMs),
      vadRegions: raw.vadRegions || []
    };
  }).filter(function (raw) { return raw.text || raw.words.length; }).sort(function (a, b) { return a.startMs - b.startMs; });
}

function assignIds(cues) {
  return cues.map(function (cue, index) {
    var id = String(index + 1);
    while (id.length < 6) id = "0" + id;
    cue.id = "seg-" + id;
    return cue;
  });
}

function buildCues(rawSegments, options) {
  options = options || {};
  var output = [];
  normalizeRawSegments(rawSegments, options.maxRelativeMs).forEach(function (raw) {
    var vadRegions = raw.vadRegions && raw.vadRegions.length ? raw.vadRegions : options.speechRegions;
    var cues = raw.words.length ? splitWords(raw.words, raw, vadRegions, options) : estimatedCues(raw);
    cues.forEach(function (cue) { output.push(cue); });
  });
  output.sort(function (a, b) { return a.relativeStartMs - b.relativeStartMs || a.relativeEndMs - b.relativeEndMs; });
  return assignIds(output);
}

function breakOpportunity(character) {
  return /\s/.test(character) || /[,.;:!?，。！？；：、…]/.test(character);
}

function trimGraphemeSpaces(chars) {
  while (chars.length && /^\s$/.test(chars[0])) chars.shift();
  while (chars.length && /^\s$/.test(chars[chars.length - 1])) chars.pop();
  return chars;
}

function naturalWrap(text, maxChars) {
  var remaining = countGraphemes(String(text || ""));
  if (!maxChars || remaining.length <= maxChars) return [String(text || "")];
  var lines = [];
  while (remaining.length > maxChars) {
    var cut = maxChars;
    var search = cut;
    while (search > Math.floor(maxChars / 2)) {
      if (breakOpportunity(remaining[search - 1])) { cut = search; break; }
      search -= 1;
    }
    while (cut > 1 && isOpeningMark(remaining[cut - 1])) cut -= 1;
    while (cut < remaining.length && isClosingMark(remaining[cut]) && cut < maxChars + 3) cut += 1;
    var lineChars = trimGraphemeSpaces(remaining.splice(0, cut));
    if (lineChars.length) lines.push(lineChars.join(""));
    trimGraphemeSpaces(remaining);
  }
  if (remaining.length) lines.push(trimGraphemeSpaces(remaining).join(""));
  return lines;
}

function makeCapacityCue(cue, words, maxChars, maxLines) {
  var text = joinWordTexts(words);
  return {
    sourceSegmentIds: cue.sourceSegmentIds,
    relativeStartMs: words[0].startMs,
    relativeEndMs: words[words.length - 1].endMs,
    sourceText: text,
    sourceLines: naturalWrap(text, maxChars).slice(0, maxLines),
    words: words,
    timingSource: "wordTimestamp",
    boundaryReason: "capacity",
    warnings: (cue.warnings || []).slice()
  };
}

function estimateCapacityChunks(cue, maxChars, maxLines) {
  var capacity = maxChars * maxLines;
  var graphemes = countGraphemes(cue.sourceText);
  var chunks = [];
  for (var index = 0; index < graphemes.length; index += capacity) chunks.push(graphemes.slice(index, index + capacity).join(""));
  var duration = Math.max(0, cue.relativeEndMs - cue.relativeStartMs);
  var totalWeight = chunks.reduce(function (sum, chunk) { return sum + Math.max(1, countGraphemes(chunk.replace(/\s/g, "")).length); }, 0) || 1;
  var cursor = cue.relativeStartMs;
  return chunks.map(function (chunk, chunkIndex) {
    var text = cleanText(chunk);
    var weight = Math.max(1, countGraphemes(text.replace(/\s/g, "")).length);
    var end = chunkIndex === chunks.length - 1 ? cue.relativeEndMs : cursor + duration * weight / totalWeight;
    var output = {
      sourceSegmentIds: cue.sourceSegmentIds,
      relativeStartMs: Math.round(cursor),
      relativeEndMs: Math.round(end),
      sourceText: text,
      sourceLines: naturalWrap(text, maxChars).slice(0, maxLines),
      words: [],
      timingSource: "estimatedCapacity",
      boundaryReason: "capacity",
      warnings: (cue.warnings || []).concat([{ code: "W_TIMING_ESTIMATED" }])
    };
    cursor = end;
    return output;
  });
}

function splitCueByCapacity(cue, options) {
  var maxChars = options.maxCharsPerLine;
  var maxLines = options.maxLines || 2;
  if (!maxChars) {
    cue.sourceLines = [cue.sourceText];
    return [cue];
  }
  var lines = naturalWrap(cue.sourceText, maxChars);
  if (lines.length <= maxLines) {
    cue.sourceLines = lines;
    return [cue];
  }
  if (!cue.words || !cue.words.length) return estimateCapacityChunks(cue, maxChars, maxLines);
  var output = [];
  var group = [];
  cue.words.forEach(function (word) {
    var candidate = group.concat([word]);
    var candidateText = joinWordTexts(candidate);
    if (group.length && naturalWrap(candidateText, maxChars).length > maxLines) {
      output.push(makeCapacityCue(cue, group, maxChars, maxLines));
      group = [word];
    } else {
      group = candidate;
    }
    if (group.length === 1 && naturalWrap(joinWordTexts(group), maxChars).length > maxLines) {
      var temporary = makeCapacityCue(cue, group, maxChars, maxLines);
      estimateCapacityChunks(temporary, maxChars, maxLines).forEach(function (piece) { output.push(piece); });
      group = [];
    }
  });
  if (group.length) output.push(makeCapacityCue(cue, group, maxChars, maxLines));
  return output;
}

function formatSegments(rawSegments, timelineInMs, options) {
  options = options || {};
  var offset = Math.round(number(timelineInMs, 0));
  var formatted = [];
  buildCues(rawSegments, options).forEach(function (cue) {
    splitCueByCapacity(cue, options).forEach(function (piece) {
      piece.startMs = offset + piece.relativeStartMs;
      piece.endMs = offset + piece.relativeEndMs;
      if (!piece.sourceLines) piece.sourceLines = options.maxCharsPerLine ? naturalWrap(piece.sourceText, options.maxCharsPerLine) : [piece.sourceText];
      formatted.push(piece);
    });
  });
  formatted = trimCuesToSpeech(formatted, options.speechRegions, offset, options.speechEdgePaddingMs, options.speechMaxExtensionMs);
  return assignIds(formatted);
}

function normaliseSpeechRegions(regions) {
  return (Array.isArray(regions) ? regions : []).map(function (region) {
    var startMs = Math.round(number(region && region.startMs, number(region && region.start, 0) * 1000));
    var endMs = Math.round(number(region && region.endMs, number(region && region.end, 0) * 1000));
    return { startMs: Math.max(0, startMs), endMs: Math.max(0, endMs) };
  }).filter(function (region) { return region.endMs > region.startMs; }).sort(function (a, b) {
    return a.startMs - b.startMs || a.endMs - b.endMs;
  });
}

function trimCuesToSpeech(cues, speechRegions, timelineInMs, edgePaddingMs, maxExtensionMs) {
  var regions = normaliseSpeechRegions(speechRegions);
  if (!regions.length) return cues || [];
  var offset = Math.round(number(timelineInMs, 0));
  var padding = Math.max(0, Math.round(number(edgePaddingMs, 0)));
  var extension = Math.max(0, Math.round(number(maxExtensionMs, 0)));
  return (cues || []).map(function (cue) {
    var cueStart = Math.round(number(cue.startMs, offset + number(cue.relativeStartMs, 0)));
    var cueEnd = Math.round(number(cue.endMs, offset + number(cue.relativeEndMs, cueStart - offset)));
    var overlaps = regions.filter(function (region) {
      return region.endMs + offset > cueStart && region.startMs + offset < cueEnd;
    });
    if (!overlaps.length) return cue;
    var speechStart = offset + overlaps[0].startMs;
    var speechEnd = offset + overlaps[overlaps.length - 1].endMs;
    var start = cueStart < speechStart ? speechStart : Math.max(speechStart, cueStart - extension);
    var end = cueEnd > speechEnd ? speechEnd : Math.min(speechEnd, cueEnd + extension);
    start = Math.max(offset, start - padding);
    end += padding;
    if (end <= start) return cue;
    cue.startMs = start;
    cue.endMs = end;
    cue.relativeStartMs = start - offset;
    cue.relativeEndMs = end - offset;
    cue.timingSource = cue.timingSource === "estimated" ? cue.timingSource : "wordTimestamp+speechBoundary";
    cue.speechBoundary = { startMs: start, endMs: end };
    return cue;
  }).filter(function (cue) { return cue.endMs > cue.startMs; });
}

function mapCuesForReverse(cues, durationMs, timelineInMs) {
  var duration = Math.max(0, Math.round(number(durationMs, 0)));
  var offset = Math.round(number(timelineInMs, 0));
  return (cues || []).map(function (cue) {
    var start = Math.max(0, Math.min(duration, Math.round(cue.startMs - offset)));
    var end = Math.max(start, Math.min(duration, Math.round(cue.endMs - offset)));
    cue.startMs = offset + duration - end;
    cue.endMs = offset + duration - start;
    cue.relativeStartMs = cue.startMs - offset;
    cue.relativeEndMs = cue.endMs - offset;
    cue.timingSource = (cue.timingSource || "") + "+reverseMapped";
    return cue;
  }).sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs; });
}

module.exports = {
  cleanText: cleanText,
  normalizeWords: normalizeWords,
  buildCues: buildCues,
  formatSegments: formatSegments,
  naturalWrap: naturalWrap,
  countGraphemes: countGraphemes,
  isStrongEnd: isStrongEnd,
  pauseThresholds: pauseThresholds,
  joinWordTexts: joinWordTexts,
  splitTextSentences: splitTextSentences,
  splitCueByCapacity: splitCueByCapacity,
  trimCuesToSpeech: trimCuesToSpeech,
  normaliseSpeechRegions: normaliseSpeechRegions,
  mapCuesForReverse: mapCuesForReverse
};
