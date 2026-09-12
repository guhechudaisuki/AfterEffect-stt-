/*
 * Comp-copy: whole-composition subtitle templates (additive module).
 *
 * The user builds one composition that renders a single subtitle line
 * (text layer plus every satellite layer serving it: particles, mattes,
 * adjustment layers, expressions, 3D, ...).  For each STT segment this
 * module duplicates the whole template comp, swaps the text inside and
 * places the duplicate into the target comp, timed to the segment.
 * Because the duplicate keeps the template's internal layer references,
 * cross-layer bindings survive without any re-linking.
 *
 * Rhythm contract (word-timed reveal so attached effects follow the new
 * line's speech rhythm, not the template's original keyframe rhythm):
 *   - Tier 1 "slider": a Slider Control effect whose name contains "LWS"
 *     and "Progress" (or "进度").  0..100 reveal progress.  The template
 *     rigs reveal and particle emitters from this slider via expressions;
 *     the plugin writes per-word keyframes from the segment's word
 *     timestamps.
 *   - Tier 2 "animator": existing keyframes on a range selector Start or
 *     Offset of the chosen text layers are re-keyed per word.  Only the
 *     reveal follows the new rhythm; attached layers stay on the stretched
 *     timeline because AE expressions cannot read animator values.
 *   - Tier 3 "linear": no driver found.  The layer stretch maps the whole
 *     template animation onto the segment duration and a warning is
 *     reported.
 *
 * This file must stay ExtendScript ES3: no ES5 keyword declarations, no
 * arrow functions, no Array.prototype iterators, no Object.keys.
 */
(function () {
    function fail(code, message, details, warnings) {
        return { ok: false, error: $._LWS.errorObject(code, message, details || {}), warnings: warnings || [] };
    }

    function activeComp() {
        return app.project && app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
    }

    function compById(id) {
        if (!app.project) return null;
        for (var i = 1; i <= app.project.numItems; i += 1) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.id === Number(id)) return item;
        }
        return null;
    }

    function isTextLayer(layer) {
        try { return layer && layer.property("ADBE Text Properties") !== null; }
        catch (ignore) { return false; }
    }

    function textSource(layer) {
        var textProps = layer.property("ADBE Text Properties");
        return textProps ? textProps.property("ADBE Text Document") : null;
    }

    function removeKeys(prop) {
        try { while (prop.numKeys > 0) prop.removeKey(prop.numKeys); } catch (ignore) {}
    }

    function clampNumber(value, minimum, maximum) {
        if (!isFinite(value)) return minimum;
        return Math.max(minimum, Math.min(maximum, value));
    }

    function findProgressDriver(comp) {
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            var effects = null;
            try { effects = layer.property("ADBE Effect Parade"); } catch (ignoreLayer) { effects = null; }
            if (!effects) continue;
            for (var e = 1; e <= effects.numProperties; e += 1) {
                var effect = effects.property(e);
                var name = "";
                var matchName = "";
                try { name = String(effect.name || ""); } catch (ignoreName) { name = ""; }
                try { matchName = String(effect.matchName || ""); } catch (ignoreMatch) { matchName = ""; }
                if (matchName !== "ADBE Slider Control") continue;
                if (!/lws/i.test(name)) continue;
                if (!(/progress/i.test(name) || name.indexOf("进度") >= 0)) continue;
                return { kind: "slider", layerIndex: layer.index, effectIndex: e, effectName: name, layerName: layer.name };
            }
        }
        return null;
    }

    function collectAnimatorLeaves(group, path, results) {
        for (var i = 1; i <= group.numProperties; i += 1) {
            var child = group.property(i);
            var type = null;
            try { type = child.propertyType; } catch (ignoreType) { continue; }
            var childPath = path.concat([i]);
            if (type === PropertyType.PROPERTY) {
                var matchName = "";
                var keyed = false;
                try { matchName = String(child.matchName || ""); } catch (ignoreMatch) { matchName = ""; }
                try { keyed = child.numKeys > 0; } catch (ignoreKeys) { keyed = false; }
                if (keyed && (matchName === "ADBE Text Selector Start" || matchName === "ADBE Text Selector Offset")) {
                    results.push({ kind: "animator", path: childPath, matchName: matchName });
                }
            } else {
                collectAnimatorLeaves(child, childPath, results);
            }
        }
    }

    function findAnimatorLocators(layer) {
        var results = [];
        var textProps = null;
        try { textProps = layer.property("ADBE Text Properties"); } catch (ignoreLayer) { textProps = null; }
        var animators = textProps ? textProps.property("ADBE Text Animators") : null;
        if (animators) collectAnimatorLeaves(animators, [], results);
        return results;
    }

    function resolveAnimatorProperty(layer, locator) {
        var textProps = layer.property("ADBE Text Properties");
        var animators = textProps ? textProps.property("ADBE Text Animators") : null;
        if (!animators) return null;
        var prop = animators;
        for (var i = 0; i < locator.path.length; i += 1) {
            try { prop = prop.property(locator.path[i]); } catch (ignoreResolve) { return null; }
        }
        return prop;
    }

    function resolveSliderProperty(compItem, driver) {
        try {
            var layer = compItem.layer(driver.layerIndex);
            var effects = layer.property("ADBE Effect Parade");
            var effect = effects.property(driver.effectIndex);
            if (!effect || effect.matchName !== "ADBE Slider Control") return null;
            return effect.property("ADBE Slider Control-0001");
        } catch (ignoreResolve) { return null; }
    }

    function segmentDisplayText(segment, displayLanguages) {
        var values = [];
        var i;
        if (displayLanguages && displayLanguages.length) {
            for (i = 0; i < displayLanguages.length; i += 1) {
                var lang = displayLanguages[i];
                if (lang === "source" && segment.sourceText !== undefined && segment.sourceText !== null) values.push(String(segment.sourceText));
                else if (segment.translations && segment.translations[lang] && segment.translations[lang].text !== undefined) values.push(String(segment.translations[lang].text));
            }
            if (values.length) return values.join("\r");
        }
        return segment.sourceLines && segment.sourceLines.length ? segment.sourceLines.join("\r") : String(segment.sourceText || "");
    }

    function pushProgressKey(keys, offsetMs, value) {
        var last = keys.length ? keys[keys.length - 1] : null;
        if (last && last.offsetMs === offsetMs) {
            if (value > last.value) last.value = value;
            return;
        }
        if (last && offsetMs < last.offsetMs) return;
        if (value < lastValueOf(keys)) return;
        keys.push({ offsetMs: offsetMs, value: value });
    }

    function lastValueOf(keys) {
        return keys.length ? keys[keys.length - 1].value : -1;
    }

    function progressKeysForSegment(segment, displayLanguages) {
        var startMs = Number(segment.startMs);
        var endMs = Number(segment.endMs);
        var durationMs = endMs - startMs;
        var text = segmentDisplayText(segment, displayLanguages);
        if (!(durationMs > 0) || !text || !String(text).length) return null;
        var words = segment.words || [];
        var relativeStart = segment.relativeStartMs === undefined || segment.relativeStartMs === null ? 0 : Number(segment.relativeStartMs);
        var usable = [];
        var i;
        for (i = 0; i < words.length; i += 1) {
            var word = words[i] || {};
            var wordStart = Number(word.startMs);
            var wordEnd = Number(word.endMs);
            var chars = word.text ? String(word.text).length : 0;
            if (!isFinite(wordStart) || !isFinite(wordEnd) || !chars) continue;
            usable.push({ startMs: wordStart, endMs: wordEnd, chars: chars });
        }
        var keys = [{ offsetMs: 0, value: 0 }];
        if (!usable.length) {
            keys.push({ offsetMs: durationMs, value: 100 });
            return { keys: keys, estimated: true };
        }
        var totalChars = 0;
        for (i = 0; i < usable.length; i += 1) totalChars += usable[i].chars;
        if (!totalChars) {
            keys.push({ offsetMs: durationMs, value: 100 });
            return { keys: keys, estimated: true };
        }
        var done = 0;
        var previousEndOffset = 0;
        for (i = 0; i < usable.length; i += 1) {
            var startOffset = clampNumber(usable[i].startMs - relativeStart, 0, durationMs);
            var endOffset = clampNumber(usable[i].endMs - relativeStart, 0, durationMs);
            if (startOffset < previousEndOffset) startOffset = previousEndOffset;
            if (endOffset < startOffset) endOffset = startOffset;
            var startValue = Math.round(done * 1000 / totalChars) / 10;
            done += usable[i].chars;
            var endValue = Math.round(done * 1000 / totalChars) / 10;
            pushProgressKey(keys, startOffset, startValue);
            pushProgressKey(keys, endOffset, endValue);
            previousEndOffset = endOffset;
        }
        pushProgressKey(keys, durationMs, 100);
        return { keys: keys, estimated: false };
    }

    function writeProgressKeys(prop, keys, spanIn, spanSeconds, segmentSeconds) {
        var i;
        removeKeys(prop);
        for (i = 0; i < keys.length; i += 1) {
            var time = spanIn + (keys[i].offsetMs / 1000) * spanSeconds / segmentSeconds;
            prop.setValueAtTime(time, keys[i].value);
        }
        try {
            for (i = 1; i <= prop.numKeys; i += 1) prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        } catch (ignoreInterpolation) {}
    }

    function replaceChosenText(compItem, textLayerIndices, text, warnings) {
        for (var i = 0; i < textLayerIndices.length; i += 1) {
            var layer = null;
            try { layer = compItem.layer(textLayerIndices[i]); } catch (ignoreLayer) { layer = null; }
            if (!layer) { warnings.push({ code: "AE_COMP_TEXT_LAYER_MISSING", layerIndex: textLayerIndices[i] }); continue; }
            var source = textSource(layer);
            if (!source) { warnings.push({ code: "AE_COMP_TEXT_LAYER_MISSING", layerIndex: textLayerIndices[i] }); continue; }
            try {
                if (source.expressionEnabled) {
                    source.expressionEnabled = false;
                    warnings.push({ code: "AE_SOURCE_TEXT_EXPRESSION_DISABLED", layerIndex: textLayerIndices[i] });
                }
            } catch (ignoreExpression) {}
            removeKeys(source);
            var document = null;
            try { document = source.value; } catch (ignoreValue) { document = null; }
            try { if (!document) document = new TextDocument(text); } catch (ignoreDocument) { document = null; }
            if (!document) { warnings.push({ code: "AE_COMP_TEXT_SET_FAILED", layerIndex: textLayerIndices[i] }); continue; }
            document.text = text;
            try { source.setValue(document); } catch (setError) { warnings.push({ code: "AE_COMP_TEXT_SET_FAILED", layerIndex: textLayerIndices[i], message: setError.toString() }); }
        }
    }

    function disableTemplateAudio(compItem, warnings, flags) {
        for (var i = 1; i <= compItem.numLayers; i += 1) {
            var layer = compItem.layer(i);
            try {
                if ((layer.hasAudio === true || layer.audioEnabled === true) && layer.audioEnabled !== false) {
                    layer.audioEnabled = false;
                    if (!flags.audioWarned) {
                        warnings.push({ code: "W_COMP_TEMPLATE_AUDIO_DISABLED", message: "模板内含音频图层，已对每句副本静音" });
                        flags.audioWarned = true;
                    }
                }
            } catch (ignoreAudio) {}
        }
    }

    function applyAutoSize(layer, template, target, warnings, flags) {
        if (template.width === target.width && template.height === target.height) return;
        var factorX = target.width / template.width;
        var factorY = target.height / template.height;
        var factor = Math.min(factorX, factorY);
        if (!isFinite(factor) || factor <= 0) return;
        var transform = layer.property("ADBE Transform Group");
        var scale = transform ? transform.property("ADBE Scale") : null;
        if (!scale) return;
        try {
            var current = scale.value;
            var value = [];
            for (var i = 0; i < current.length; i += 1) value.push(Number(current[i]) * factor);
            removeKeys(scale);
            scale.setValue(value);
            if (!flags.scaledWarned) {
                warnings.push({ code: "W_COMP_TEMPLATE_SCALED", message: "模板与目标合成尺寸不一致，已按 " + Math.round(factor * 100) + "% 缩放" });
                flags.scaledWarned = true;
            }
        } catch (errorScale) {
            warnings.push({ code: "W_COMP_TEMPLATE_SCALE_FAILED", message: errorScale.toString() });
        }
    }

    function ensureOutputFolder() {
        for (var i = 1; i <= app.project.numItems; i += 1) {
            var item = app.project.item(i);
            if (item instanceof FolderItem && item.name === "LWS 合成模板") return item;
        }
        try { return app.project.items.addFolder("LWS 合成模板"); }
        catch (ignoreFolder) { return null; }
    }

    function templateSpan(comp, chosenLayers) {
        var spanIn = Infinity;
        var spanOut = -Infinity;
        for (var i = 0; i < chosenLayers.length; i += 1) {
            try {
                if (chosenLayers[i].inPoint < spanIn) spanIn = chosenLayers[i].inPoint;
                if (chosenLayers[i].outPoint > spanOut) spanOut = chosenLayers[i].outPoint;
            } catch (ignoreSpan) {}
        }
        if (!isFinite(spanIn) || !isFinite(spanOut)) { spanIn = 0; spanOut = comp.duration; }
        spanIn = clampNumber(spanIn, 0, comp.duration);
        spanOut = clampNumber(spanOut, 0, comp.duration);
        if (!(spanOut - spanIn > 0)) { spanIn = 0; spanOut = comp.duration; }
        if (!(spanOut - spanIn > 0)) return null;
        return { inPoint: spanIn, outPoint: spanOut };
    }

    $._LWS.register("ae.comp.templateInfo", function (params) {
        var comp = compById(params.compId);
        if (!comp) return fail("AE_COMP_TEMPLATE_NOT_FOUND", "找不到模板合成", { compId: params.compId || null });
        var textLayers = [];
        var hasAudio = false;
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            if (isTextLayer(layer)) textLayers.push({ layerId: layer.id, name: layer.name, index: layer.index, inPoint: layer.inPoint, outPoint: layer.outPoint });
            try { if (layer.hasAudio === true || layer.audioEnabled === true) hasAudio = true; } catch (ignoreAudio) {}
        }
        if (!textLayers.length) return fail("AE_COMP_TEMPLATE_NO_TEXT_LAYER", "模板合成里没有文字图层", { compId: comp.id });
        var driver = findProgressDriver(comp);
        return { data: { compId: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, textLayers: textLayers, progressDriver: driver ? { kind: "slider", effectName: driver.effectName, layerName: driver.layerName } : null, hasAudioLayers: hasAudio }, warnings: [] };
    });

    $._LWS.register("ae.comp.subtitles.create", function (params) {
        var comp = compById(params.compId) || activeComp();
        if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成");
        var template = compById(params.templateCompId);
        if (!template) return fail("AE_COMP_TEMPLATE_NOT_FOUND", "找不到模板合成", { templateCompId: params.templateCompId || null });
        if (template.id === comp.id) return fail("AE_COMP_TEMPLATE_IS_TARGET", "模板合成不能是目标合成本身");
        var payload = params.segmentsFile ? $._LWS.readJsonFile(params.segmentsFile) : { segments: params.segments || [] };
        var segments = payload.segments || [];
        if (!segments.length) return fail("AE_COMP_NO_SEGMENTS", "没有可生成的字幕分段");

        var wanted = {};
        var wantedAny = params.textLayerIds !== undefined && params.textLayerIds !== null && params.textLayerIds.length;
        var i;
        if (wantedAny) for (i = 0; i < params.textLayerIds.length; i += 1) wanted[String(Number(params.textLayerIds[i]))] = true;
        var chosen = [];
        var textLayerIndices = [];
        for (i = 1; i <= template.numLayers; i += 1) {
            var layer = template.layer(i);
            if (!isTextLayer(layer)) continue;
            if (wantedAny && !wanted[String(layer.id)]) continue;
            chosen.push(layer);
            textLayerIndices.push(layer.index);
        }
        if (!chosen.length) return fail("AE_COMP_TEMPLATE_NO_TEXT_LAYER", "模板合成里没有可接收字幕文字的图层", { templateCompId: template.id });
        var span = templateSpan(template, chosen);
        if (!span) return fail("AE_COMP_TEMPLATE_INVALID_SPAN", "模板合成的有效时长为零", { templateCompId: template.id });

        var driver = findProgressDriver(template);
        var animatorLocators = [];
        if (!driver) {
            for (i = 0; i < chosen.length; i += 1) {
                var locators = findAnimatorLocators(chosen[i]);
                for (var l = 0; l < locators.length; l += 1) {
                    locators[l].layerIndex = textLayerIndices[i];
                    animatorLocators.push(locators[l]);
                }
            }
        }
        var timingMode = driver ? "slider" : (animatorLocators.length ? "animator" : "linear");
        var warnings = [];
        if (timingMode === "linear") warnings.push({ code: "W_COMP_TEMPLATE_LINEAR_TIMING", message: "模板没有 LWS Progress 滑杆，也没有可重定位的动画器关键帧，整段动画按句长线性拉伸" });

        var flags = { audioWarned: false, scaledWarned: false };
        var folder = ensureOutputFolder();
        var created = [];
        var spanSeconds = span.outPoint - span.inPoint;

        app.beginUndoGroup("LWS 合成模板字幕");
        try {
            for (i = 0; i < segments.length; i += 1) {
                var segment = segments[i];
                var start = Number(segment.startMs) / 1000;
                var end = Number(segment.endMs) / 1000;
                if (!(end > start) || start < 0) { warnings.push({ code: "AE_COMP_INVALID_SEGMENT", segmentId: segment.id || null }); continue; }
                var text = segmentDisplayText(segment, params.displayLanguages);
                if (!text) { warnings.push({ code: "AE_COMP_INVALID_SEGMENT", segmentId: segment.id || null }); continue; }
                var dup = null;
                var placed = null;
                try {
                    dup = template.duplicate();
                    dup.name = (params.layerPrefix || "LWS 合成字幕") + " " + (i + 1);
                    try { if (folder) dup.parentFolder = folder; } catch (ignoreFolder) {}
                    disableTemplateAudio(dup, warnings, flags);
                    replaceChosenText(dup, textLayerIndices, text, warnings);
                    var timing = progressKeysForSegment(segment, params.displayLanguages);
                    if (timing && timing.estimated) warnings.push({ code: "W_COMP_TIMING_ESTIMATED", segmentId: segment.id || null });
                    if (timing && timingMode === "slider") {
                        var sliderProp = resolveSliderProperty(dup, driver);
                        if (sliderProp) writeProgressKeys(sliderProp, timing.keys, span.inPoint, spanSeconds, end - start);
                        else if (!flags.sliderLostWarned) { warnings.push({ code: "W_COMP_TEMPLATE_LINEAR_TIMING", message: "滑杆在副本上解析失败，本句退化为线性拉伸" }); flags.sliderLostWarned = true; }
                    } else if (timing && timingMode === "animator") {
                        for (var a = 0; a < animatorLocators.length; a += 1) {
                            var animatorProp = resolveAnimatorProperty(dup.layer(animatorLocators[a].layerIndex), animatorLocators[a]);
                            if (animatorProp) writeProgressKeys(animatorProp, timing.keys, span.inPoint, spanSeconds, end - start);
                        }
                    }
                    placed = comp.layers.add(dup);
                    var segmentSeconds = end - start;
                    var stretch = (segmentSeconds / spanSeconds) * 100;
                    placed.stretch = stretch;
                    placed.startTime = start - span.inPoint * stretch / 100;
                    placed.inPoint = start;
                    placed.outPoint = end;
                    applyAutoSize(placed, template, comp, warnings, flags);
                    created.push({ segmentId: segment.id || null, compItemId: dup.id, layerId: placed.id, layerIndex: placed.index, timingMode: timingMode });
                } catch (error) {
                    warnings.push({ code: "AE_COMP_STAMP_FAILED", segmentId: segment.id || null, message: error.toString() });
                    try { if (placed) placed.remove(); } catch (ignorePlaced) {}
                    try { if (!placed && dup) dup.remove(); } catch (ignoreDup) {}
                }
            }
        } finally { app.endUndoGroup(); }
        if (!created.length) return fail("AE_ALL_ITEMS_FAILED", "没有成功生成任何合成模板字幕", {}, warnings);
        return { data: { created: created, count: created.length, timingMode: timingMode }, warnings: warnings };
    });
}());
