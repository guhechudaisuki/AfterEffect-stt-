(function () {
    $._LWS.aepImports = $._LWS.aepImports || {};

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

    function layerById(comp, id) {
        if (!comp) return null;
        for (var i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            if (layer.id === Number(id)) return layer;
        }
        return null;
    }

    function isTextLayer(layer) {
        try { return layer && layer.property("ADBE Text Properties") !== null; }
        catch (ignore) { return false; }
    }

    function layerRef(layer, comp) {
        return {
            compId: comp.id,
            layerId: layer.id,
            index: layer.index,
            name: layer.name,
            isText: isTextLayer(layer),
            hasAudio: !!(layer.hasAudio === true || layer.audioEnabled === true),
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            startTime: layer.startTime,
            stretch: layer.stretch,
            is3D: !!layer.threeDLayer
        };
    }

    function textSource(layer) {
        var textProps = layer.property("ADBE Text Properties");
        return textProps ? textProps.property("ADBE Text Document") : null;
    }

    function findCopiedLayer(comp, beforeIds) {
        for (var i = 1; i <= comp.numLayers; i += 1) {
            if (!beforeIds[comp.layer(i).id]) return comp.layer(i);
        }
        return null;
    }

    function idSet(comp) {
        var result = {};
        for (var i = 1; i <= comp.numLayers; i += 1) result[comp.layer(i).id] = true;
        return result;
    }

    function safeValue(value) {
        var result;
        var fields;
        var i;
        if (value === null || value === undefined) return null;
        if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
        if (value instanceof Array) {
            var array = [];
            for (i = 0; i < value.length; i += 1) array.push(safeValue(value[i]));
            return array;
        }
        try {
            if (value.text !== undefined && value.fontSize !== undefined) {
                result = { kind: "TextDocument" };
                fields = ["text", "font", "fontFamily", "fontStyle", "fontSize", "tracking", "leading", "autoLeading", "applyFill", "fillColor", "applyStroke", "strokeColor", "strokeWidth", "strokeOverFill", "baselineShift", "horizontalScale", "verticalScale", "fauxBold", "fauxItalic", "allCaps", "smallCaps", "superscript", "subscript", "ligature", "noBreak", "boxText", "boxTextPos", "boxTextSize"];
                for (i = 0; i < fields.length; i += 1) {
                    try { result[fields[i]] = safeValue(value[fields[i]]); } catch (ignoreTextField) {}
                }
                try { result.justification = String(value.justification); } catch (ignoreJustification) {}
                return result;
            }
        } catch (ignoreText) {}
        try {
            if (typeof Shape !== "undefined" && value instanceof Shape) {
                result = { kind: "Shape" };
                fields = ["vertices", "inTangents", "outTangents", "closed", "featherSegLocs", "featherRelSegLocs", "featherRadii", "featherInterps", "featherTensions", "featherTypes", "featherRelCornerAngles"];
                for (i = 0; i < fields.length; i += 1) {
                    try { result[fields[i]] = safeValue(value[fields[i]]); } catch (ignoreShapeField) {}
                }
                return result;
            }
        } catch (ignoreShape) {}
        try {
            if (typeof MarkerValue !== "undefined" && value instanceof MarkerValue) {
                result = { kind: "MarkerValue" };
                fields = ["comment", "chapter", "cuePointName", "duration", "eventCuePoint", "frameTarget", "label", "protectedRegion", "url"];
                for (i = 0; i < fields.length; i += 1) {
                    try { result[fields[i]] = safeValue(value[fields[i]]); } catch (ignoreMarkerField) {}
                }
                try { result.parameters = safeValue(value.getParameters()); } catch (ignoreParameters) {}
                return result;
            }
        } catch (ignoreMarker) {}
        try { return String(value); } catch (ignore) { return { kind: "opaque", readable: false }; }
    }

    function ownerModuleForPath(pathItems) {
        if (!pathItems.length) return null;
        for (var i = 0; i < pathItems.length; i += 1) {
            var entry = pathItems[i];
            var parent = i > 0 ? pathItems[i - 1] : null;
            if (parent && parent.matchName === "ADBE Effect Parade") return "effect:" + entry.index + ":" + entry.matchName;
            if (parent && parent.matchName === "ADBE Text Animators") return "animator:" + entry.index + ":" + entry.matchName;
            if (parent && parent.matchName === "ADBE Mask Parade") return "mask:" + entry.index + ":" + entry.matchName;
            if (parent && parent.matchName === "ADBE Layer Styles") return "layerStyle:" + entry.index + ":" + entry.matchName;
            if (entry.matchName === "ADBE Transform Group") return "transform";
            if (entry.matchName === "ADBE Text Document") return "textStyle";
        }
        return null;
    }

    function moduleForNode(pathItems) {
        var last;
        var parent;
        if (!pathItems.length) return null;
        last = pathItems[pathItems.length - 1];
        parent = pathItems.length > 1 ? pathItems[pathItems.length - 2] : null;
        if (last.matchName === "ADBE Transform Group") return "transform";
        if (last.matchName === "ADBE Text Document") return "textStyle";
        if (parent && parent.matchName === "ADBE Effect Parade") return "effect:" + last.index + ":" + last.matchName;
        if (parent && parent.matchName === "ADBE Text Animators") return "animator:" + last.index + ":" + last.matchName;
        if (parent && parent.matchName === "ADBE Mask Parade") return "mask:" + last.index + ":" + last.matchName;
        if (parent && parent.matchName === "ADBE Layer Styles") return "layerStyle:" + last.index + ":" + last.matchName;
        return null;
    }

    function serializeKey(prop, index, warnings) {
        var item = { index: index };
        try { item.time = prop.keyTime(index); } catch (errorTime) { warnings.push({ code: "AE_KEY_TIME_READ_FAILED", message: errorTime.toString() }); }
        try { item.value = safeValue(prop.keyValue(index)); } catch (errorValue) { item.value = { kind: "opaque", readable: false }; warnings.push({ code: "AE_KEY_VALUE_READ_FAILED", message: errorValue.toString() }); }
        try { item.inInterpolation = String(prop.keyInInterpolationType(index)); item.outInterpolation = String(prop.keyOutInterpolationType(index)); } catch (ignoreInterpolation) {}
        try {
            var inEase = prop.keyInTemporalEase(index);
            var outEase = prop.keyOutTemporalEase(index);
            item.inTemporalEase = [];
            item.outTemporalEase = [];
            for (var i = 0; i < inEase.length; i += 1) item.inTemporalEase.push({ speed: inEase[i].speed, influence: inEase[i].influence });
            for (var j = 0; j < outEase.length; j += 1) item.outTemporalEase.push({ speed: outEase[j].speed, influence: outEase[j].influence });
        } catch (ignoreEase) {}
        try { item.temporalContinuous = prop.keyTemporalContinuous(index); item.temporalAutoBezier = prop.keyTemporalAutoBezier(index); } catch (ignoreTemporal) {}
        try { item.inSpatialTangent = safeValue(prop.keyInSpatialTangent(index)); item.outSpatialTangent = safeValue(prop.keyOutSpatialTangent(index)); item.spatialContinuous = prop.keySpatialContinuous(index); item.spatialAutoBezier = prop.keySpatialAutoBezier(index); item.roving = prop.keyRoving(index); } catch (ignoreSpatial) {}
        try { item.label = prop.keyLabel(index); } catch (ignoreLabel) {}
        try { item.selected = prop.keySelected(index); } catch (ignoreSelected) {}
        return item;
    }

    function serializeProperty(prop, pathItems, depth, warnings, sampleTime) {
        var entry = { index: prop.propertyIndex || 0, matchName: prop.matchName || "" };
        var currentPath = pathItems.slice(0);
        var isLeaf = false;
        currentPath.push(entry);
        var node = {
            name: prop.name,
            matchName: prop.matchName,
            propertyIndex: prop.propertyIndex,
            propertyType: String(prop.propertyType),
            path: currentPath,
            moduleId: moduleForNode(currentPath),
            ownerModuleId: ownerModuleForPath(currentPath),
            children: [],
            keys: []
        };
        try { isLeaf = prop.propertyType === PropertyType.PROPERTY; }
        catch (ignorePropertyType) { try { isLeaf = prop.propertyValueType !== undefined; } catch (ignoreLeafValueType) {} }
        try { node.enabled = prop.enabled; } catch (ignoreEnabled) { node.enabled = null; }
        if (isLeaf) {
            try { node.canSetExpression = prop.canSetExpression; node.expressionEnabled = prop.expressionEnabled; node.expression = prop.expression ? prop.expression : null; node.expressionError = prop.expressionError; } catch (ignoreExpression) {}
            try { node.propertyValueType = String(prop.propertyValueType); } catch (ignoreValueType) {}
            try { node.isTimeVarying = prop.isTimeVarying; node.canVaryOverTime = prop.canVaryOverTime; } catch (ignoreTimeFlags) {}
            try { node.unitsText = prop.unitsText; } catch (ignoreUnits) {}
            try { node.hasMin = prop.hasMin; if (node.hasMin) node.minValue = prop.minValue; } catch (ignoreMin) {}
            try { node.hasMax = prop.hasMax; if (node.hasMax) node.maxValue = prop.maxValue; } catch (ignoreMax) {}
            try {
                if (typeof PropertyValueType !== "undefined" && prop.propertyValueType === PropertyValueType.CUSTOM_VALUE) {
                    node.value = { kind: "opaque", readable: false };
                    warnings.push({ code: "AE_UNSUPPORTED_PROPERTY_VALUE", name: prop.name, matchName: prop.matchName });
                } else {
                    node.value = safeValue(prop.value);
                    if (sampleTime !== null && sampleTime !== undefined && prop.valueAtTime) node.valueAtTime = safeValue(prop.valueAtTime(sampleTime, false));
                }
            } catch (errorValue) {
                node.value = { kind: "opaque", readable: false };
                warnings.push({ code: "AE_PROPERTY_VALUE_READ_FAILED", name: prop.name, matchName: prop.matchName, message: errorValue.toString() });
            }
            try { for (var k = 1; k <= prop.numKeys; k += 1) node.keys.push(serializeKey(prop, k, warnings)); } catch (ignoreKeys) {}
        }
        if (depth < 64) {
            try {
                for (var i = 1; i <= prop.numProperties; i += 1) node.children.push(serializeProperty(prop.property(i), currentPath, depth + 1, warnings, sampleTime));
            } catch (errorChildren) { warnings.push({ code: "AE_PROPERTY_CHILDREN_READ_FAILED", name: prop.name, message: errorChildren.toString() }); }
        } else warnings.push({ code: "AE_PROPERTY_TREE_DEPTH_LIMIT", name: prop.name, depth: depth });
        return node;
    }

    function applyTextOverrides(document, overrides) {
        overrides = overrides || {};
        try { if (overrides.font !== null && overrides.font !== undefined) document.font = overrides.font; } catch (ignoreFont) {}
        try { if (overrides.fontSize !== null && overrides.fontSize !== undefined) document.fontSize = Number(overrides.fontSize); } catch (ignoreSize) {}
        try { if (overrides.tracking !== null && overrides.tracking !== undefined) document.tracking = Number(overrides.tracking); } catch (ignoreTracking) {}
        try { if (overrides.leading !== null && overrides.leading !== undefined) { document.leading = Number(overrides.leading); document.autoLeading = false; } } catch (ignoreLeading) {}
        return document;
    }

    function makeTextDocument(layer, text, overrides) {
        var source = textSource(layer);
        var document;
        try { document = source.value; } catch (ignore) { document = new TextDocument(text); }
        document.text = text;
        return applyTextOverrides(document, overrides);
    }

    function replaceText(layer, text, overrides, warnings) {
        var source = textSource(layer);
        if (!source) throw new Error("Layer has no Source Text property");
        try {
            if (source.expressionEnabled) {
                source.expressionEnabled = false;
                warnings.push({ code: "AE_SOURCE_TEXT_EXPRESSION_DISABLED", layerId: layer.id });
            }
        } catch (ignoreExpression) {}
        if (source.numKeys > 0) {
            for (var i = 1; i <= source.numKeys; i += 1) {
                var keyed = source.keyValue(i);
                keyed.text = text;
                applyTextOverrides(keyed, overrides);
                source.setValueAtKey(i, keyed);
            }
        } else source.setValue(makeTextDocument(layer, text, overrides));
    }

    function shiftScalarPosition(prop, desired, sampleTime, layer, warnings) {
        var current;
        var delta;
        var i;
        try {
            if (prop.expressionEnabled) {
                warnings.push({ code: "AE_POSITION_EXPRESSION_CONFLICT", layerId: layer.id, matchName: prop.matchName });
                return;
            }
        } catch (ignoreExpression) {}
        if (prop.numKeys > 0) {
            current = Number(prop.valueAtTime(sampleTime, false));
            delta = desired - current;
            for (i = 1; i <= prop.numKeys; i += 1) prop.setValueAtKey(i, Number(prop.keyValue(i)) + delta);
        } else prop.setValue(desired);
    }

    function setCenterPosition(layer, comp, position, warnings) {
        if (!position) return;
        var transform = layer.property("ADBE Transform Group");
        var prop = transform && transform.property("ADBE Position");
        if (!prop) return;
        try {
            if (prop.expressionEnabled) {
                warnings.push({ code: "AE_POSITION_EXPRESSION_CONFLICT", layerId: layer.id });
                return;
            }
        } catch (ignoreExpression) {}
        var x = position.unit === "percent" ? comp.width * Number(position.x) / 100 : Number(position.x);
        var y = position.unit === "percent" ? comp.height * Number(position.y) / 100 : Number(position.y);
        if (!isFinite(x) || !isFinite(y)) { warnings.push({ code: "AE_INVALID_POSITION", layerId: layer.id, x: position.x, y: position.y }); return; }
        try {
            if (prop.dimensionsSeparated && prop.getSeparationFollower) {
                shiftScalarPosition(prop.getSeparationFollower(0), x, layer.inPoint, layer, warnings);
                shiftScalarPosition(prop.getSeparationFollower(1), y, layer.inPoint, layer, warnings);
                return;
            }
        } catch (separatedError) { warnings.push({ code: "AE_POSITION_SEPARATED_DIMENSION_FAILED", layerId: layer.id, message: separatedError.toString() }); }
        if (prop.numKeys > 0) {
            var atStart = prop.valueAtTime(layer.inPoint, false);
            var dx = x - atStart[0];
            var dy = y - atStart[1];
            for (var i = 1; i <= prop.numKeys; i += 1) {
                var value = prop.keyValue(i);
                value[0] += dx;
                value[1] += dy;
                prop.setValueAtKey(i, value);
            }
        } else {
            var current = prop.value;
            if (current.length > 2) prop.setValue([x, y, current[2]]);
            else prop.setValue([x, y]);
        }
    }

    function moduleEnabled(selection, id) {
        return !selection || selection[id] !== false;
    }

    function clearAnimatedProperty(prop) {
        try { if (prop.canSetExpression && prop.expressionEnabled) prop.expressionEnabled = false; } catch (ignoreExpression) {}
        removeKeys(prop);
    }

    function resetTransform(layer, warnings) {
        var transform = layer.property("ADBE Transform Group");
        var defaults = {
            "ADBE Anchor Point": null,
            "ADBE Scale": null,
            "ADBE Orientation": [0, 0, 0],
            "ADBE Rotate X": 0,
            "ADBE Rotate Y": 0,
            "ADBE Rotate Z": 0,
            "ADBE Rotation": 0,
            "ADBE Opacity": 100,
            "ADBE Skew": 0,
            "ADBE Skew Axis": 0
        };
        if (!transform) return;
        for (var i = 1; i <= transform.numProperties; i += 1) {
            var prop = transform.property(i);
            var value;
            clearAnimatedProperty(prop);
            if (prop.matchName === "ADBE Position") {
                try {
                    if (prop.dimensionsSeparated && prop.getSeparationFollower) {
                        clearAnimatedProperty(prop.getSeparationFollower(0));
                        clearAnimatedProperty(prop.getSeparationFollower(1));
                        if (layer.threeDLayer) clearAnimatedProperty(prop.getSeparationFollower(2));
                    }
                } catch (ignoreSeparated) {}
                continue;
            }
            if (defaults[prop.matchName] === undefined) continue;
            value = defaults[prop.matchName];
            if (prop.matchName === "ADBE Anchor Point") value = layer.threeDLayer ? [0, 0, 0] : [0, 0];
            if (prop.matchName === "ADBE Scale") value = layer.threeDLayer ? [100, 100, 100] : [100, 100];
            try { prop.setValue(value); } catch (error) { warnings.push({ code: "AE_TRANSFORM_RESET_FAILED", matchName: prop.matchName, layerId: layer.id }); }
        }
    }

    function disableLayerStyle(style) {
        try { style.enabled = false; return true; } catch (ignoreEnabled) {}
        try {
            for (var i = 1; i <= style.numProperties; i += 1) {
                var child = style.property(i);
                if (/\/enabled$/i.test(String(child.matchName || ""))) { child.setValue(0); return true; }
            }
        } catch (ignoreChildren) {}
        return false;
    }

    function pruneModules(layer, selection, warnings) {
        if (!selection) return;
        var effects = layer.property("ADBE Effect Parade");
        var i;
        if (effects) for (i = effects.numProperties; i >= 1; i -= 1) {
            var effect = effects.property(i);
            if (!moduleEnabled(selection, "effect:" + i + ":" + effect.matchName)) try { effect.remove(); } catch (errorEffect) { warnings.push({ code: "AE_MODULE_REMOVE_FAILED", name: effect.name }); }
        }
        var textProps = layer.property("ADBE Text Properties");
        var animators = textProps && textProps.property("ADBE Text Animators");
        if (animators) for (i = animators.numProperties; i >= 1; i -= 1) {
            var animator = animators.property(i);
            if (!moduleEnabled(selection, "animator:" + i + ":" + animator.matchName)) try { animator.remove(); } catch (errorAnimator) { warnings.push({ code: "AE_MODULE_REMOVE_FAILED", name: animator.name }); }
        }
        var masks = layer.property("ADBE Mask Parade");
        if (masks) for (i = masks.numProperties; i >= 1; i -= 1) {
            var mask = masks.property(i);
            if (!moduleEnabled(selection, "mask:" + i + ":" + mask.matchName)) try { mask.remove(); } catch (errorMask) { warnings.push({ code: "AE_MODULE_REMOVE_FAILED", name: mask.name }); }
        }
        var styles = layer.property("ADBE Layer Styles");
        if (styles) for (i = styles.numProperties; i >= 1; i -= 1) {
            var style = styles.property(i);
            if (!moduleEnabled(selection, "layerStyle:" + i + ":" + style.matchName)) {
                try { style.remove(); }
                catch (errorStyle) {
                    if (!disableLayerStyle(style)) warnings.push({ code: "AE_LAYER_STYLE_DISABLE_FAILED", name: style.name, layerId: layer.id });
                }
            }
        }
        if (!moduleEnabled(selection, "transform")) resetTransform(layer, warnings);
        if (!moduleEnabled(selection, "textStyle")) {
            var source = textSource(layer);
            if (source) {
                var text = "";
                try { text = source.value.text; } catch (ignoreText) {}
                clearAnimatedProperty(source);
                try { source.setValue(new TextDocument(text)); } catch (errorDocument) { warnings.push({ code: "AE_TEXT_STYLE_RESET_FAILED", layerId: layer.id }); }
            }
        }
    }

    function copyTemplateLayer(sourceLayer, sourceComp, targetComp, start, end, warnings) {
        var before = idSet(targetComp);
        var layer;
        if (sourceComp.id === targetComp.id) layer = sourceLayer.duplicate();
        else {
            sourceLayer.copyToComp(targetComp);
            layer = findCopiedLayer(targetComp, before);
        }
        if (!layer) throw new Error("Template layer copy failed");
        try { layer.locked = false; } catch (ignoreLocked) {}
        var sourceDuration = sourceLayer.outPoint - sourceLayer.inPoint;
        var targetDuration = end - start;
        if (sourceDuration <= 0 || targetDuration <= 0) throw new Error("Template or target duration is zero");
        var ratio = targetDuration / sourceDuration;
        try { layer.stretch = sourceLayer.stretch * ratio; }
        catch (errorStretch) { warnings.push({ code: "AE_TEMPLATE_STRETCH_FAILED", message: errorStretch.toString() }); throw errorStretch; }
        layer.startTime = start - (sourceLayer.inPoint - sourceLayer.startTime) * ratio;
        layer.inPoint = start;
        layer.outPoint = end;
        return layer;
    }

    function createPlainTextLayer(comp, text, start, end, overrides) {
        var layer = comp.layers.addText(text);
        layer.inPoint = start;
        layer.outPoint = end;
        textSource(layer).setValue(makeTextDocument(layer, text, overrides));
        return layer;
    }

    function segmentText(segment, params) {
        if (params.displayLanguages && params.displayLanguages.length) {
            var values = [];
            for (var i = 0; i < params.displayLanguages.length; i += 1) {
                var lang = params.displayLanguages[i];
                if (lang === "source" && segment.sourceText !== undefined && segment.sourceText !== null) values.push(String(segment.sourceText));
                else if (segment.translations && segment.translations[lang] && segment.translations[lang].text !== undefined) values.push(String(segment.translations[lang].text));
            }
            if (values.length) return values.join("\r");
        }
        return segment.sourceLines && segment.sourceLines.length ? segment.sourceLines.join("\r") : String(segment.sourceText || "");
    }

    function templateForIndex(refs, index) {
        if (!refs || !refs.length) return null;
        var ref = refs[index % refs.length];
        var comp = compById(ref.compId);
        var layer = layerById(comp, ref.layerId);
        return layer ? { comp: comp, layer: layer } : null;
    }

    function removeKeys(prop) {
        try { while (prop.numKeys > 0) prop.removeKey(prop.numKeys); } catch (ignore) {}
    }

    function createPerSegment(params, comp, segments, warnings) {
        var created = [];
        for (var i = 0; i < segments.length; i += 1) {
            var segment = segments[i];
            var start = Number(segment.startMs) / 1000;
            var end = Number(segment.endMs) / 1000;
            if (!(end > start)) { warnings.push({ code: "AE_INVALID_SEGMENT_TIME", segmentId: segment.id }); continue; }
            var text = segmentText(segment, params);
            var template = templateForIndex(params.templateLayers, i);
            var layer = null;
            if (params.templateLayers && params.templateLayers.length && !template) warnings.push({ code: "AE_LAYER_NOT_FOUND", segmentId: segment.id, template: params.templateLayers[i % params.templateLayers.length] });
            try {
                layer = template ? copyTemplateLayer(template.layer, template.comp, comp, start, end, warnings) : createPlainTextLayer(comp, text, start, end, params.styleOverrides || {});
                pruneModules(layer, params.moduleSelections, warnings);
                replaceText(layer, text, params.styleOverrides || {}, warnings);
                setCenterPosition(layer, comp, params.position, warnings);
                layer.name = (params.layerPrefix || "LWS 字幕") + " " + (i + 1);
                created.push({ segmentId: segment.id, layerId: layer.id, templateLayerId: template ? template.layer.id : null });
            } catch (error) {
                warnings.push({ code: "AE_TEMPLATE_COPY_FAILED", segmentId: segment.id, message: error.toString() });
                try { if (layer) layer.remove(); } catch (ignorePartialLayer) {}
                try {
                    layer = createPlainTextLayer(comp, text, start, end, params.styleOverrides || {});
                    setCenterPosition(layer, comp, params.position, warnings);
                    layer.name = (params.layerPrefix || "LWS 字幕") + " " + (i + 1) + " [fallback]";
                    created.push({ segmentId: segment.id, layerId: layer.id, fallback: true });
                } catch (fallbackError) { warnings.push({ code: "AE_FALLBACK_LAYER_FAILED", segmentId: segment.id, message: fallbackError.toString() }); }
            }
        }
        return created;
    }

    function propertyTreeHasAnimation(prop) {
        try {
            if (prop.matchName !== "ADBE Text Document" && prop.numKeys > 0) return true;
        } catch (ignoreKeys) {}
        try {
            for (var i = 1; i <= prop.numProperties; i += 1) if (propertyTreeHasAnimation(prop.property(i))) return true;
        } catch (ignoreChildren) {}
        return false;
    }

    function documentFromTemplate(params, templateIndex, fallbackLayer, text, warnings) {
        var template = templateForIndex(params.templateLayers, templateIndex);
        var document;
        if (!moduleEnabled(params.moduleSelections, "textStyle")) return applyTextOverrides(new TextDocument(text), params.styleOverrides || {});
        if (template && isTextLayer(template.layer)) {
            try {
                document = textSource(template.layer).value;
                document.text = text;
                return applyTextOverrides(document, params.styleOverrides || {});
            } catch (error) { warnings.push({ code: "AE_TEXT_STYLE_COPY_FAILED", layerId: template.layer.id, message: error.toString() }); }
        }
        return makeTextDocument(fallbackLayer, text, params.styleOverrides || {});
    }

    function createSingleLayer(params, comp, segments, warnings) {
        if (!segments.length) return [];
        var valid = [];
        var previousEnd = null;
        var index;
        for (index = 0; index < segments.length; index += 1) {
            var candidateStart = Number(segments[index].startMs);
            var candidateEnd = Number(segments[index].endMs);
            if (!(candidateEnd > candidateStart) || (previousEnd !== null && candidateStart < previousEnd)) {
                warnings.push({ code: "AE_INVALID_SEGMENT_TIME", segmentId: segments[index].id });
                continue;
            }
            valid.push(segments[index]);
            previousEnd = candidateEnd;
        }
        if (!valid.length) return [];
        var first = valid[0];
        var last = valid[valid.length - 1];
        var template = templateForIndex(params.templateLayers, 0);
        var layer = template ? copyTemplateLayer(template.layer, template.comp, comp, Number(first.startMs) / 1000, Number(last.endMs) / 1000, warnings) : createPlainTextLayer(comp, "", Number(first.startMs) / 1000, Number(last.endMs) / 1000, params.styleOverrides || {});
        pruneModules(layer, params.moduleSelections, warnings);
        var source = textSource(layer);
        removeKeys(source);
        try {
            if (source.expressionEnabled) {
                source.expressionEnabled = false;
                warnings.push({ code: "AE_SOURCE_TEXT_EXPRESSION_DISABLED", layerId: layer.id });
            }
        } catch (ignoreExpression) {}
        for (var i = 0; i < valid.length; i += 1) {
            var segment = valid[i];
            var text = segmentText(segment, params);
            var document = documentFromTemplate(params, i, layer, text, warnings);
            source.setValueAtTime(Number(segment.startMs) / 1000, document);
            var next = valid[i + 1];
            if (!next || Number(next.startMs) > Number(segment.endMs)) source.setValueAtTime(Number(segment.endMs) / 1000, documentFromTemplate(params, i, layer, "", warnings));
        }
        try {
            for (i = 1; i <= source.numKeys; i += 1) source.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
        } catch (ignoreHold) {}
        layer.inPoint = Number(first.startMs) / 1000;
        layer.outPoint = Number(last.endMs) / 1000;
        layer.name = params.layerPrefix || "LWS 字幕（单层）";
        setCenterPosition(layer, comp, params.position, warnings);
        if (template && propertyTreeHasAnimation(template.layer)) warnings.push({ code: "AE_SINGLE_LAYER_ANIMATION_NOT_RETRIGGERED", message: "单层模式中的模板动画只播放一次" });
        if (params.templateLayers && params.templateLayers.length > 1) warnings.push({ code: "AE_SINGLE_LAYER_TEMPLATE_MODULES_NOT_ROTATED", message: "单层模式只轮换 Text Style，其他模块使用第一个模板" });
        return [{ layerId: layer.id, singleLayer: true }];
    }

    function mapReferenceValue(source, sourceLayer, targetLayer, sourceValue) {
        var value;
        var sourceComp;
        var targetComp;
        var referenceLayer;
        var targetReference;
        var sourceMasks;
        var targetMasks;
        var sourceMask;
        var targetMask;
        var ordinal;
        try { value = Number(sourceValue !== undefined ? sourceValue : source.value); } catch (ignoreValue) { return { mapped: false, code: "AE_REFERENCE_VALUE_READ_FAILED" }; }
        if (value === 0) return { mapped: true, value: 0 };
        try {
            if (source.propertyValueType === PropertyValueType.LAYER_INDEX) {
                sourceComp = sourceLayer.containingComp;
                targetComp = targetLayer.containingComp;
                referenceLayer = sourceComp.layer(value);
                targetReference = layerById(targetComp, referenceLayer.id);
                if (targetReference) return { mapped: true, value: targetReference.index };
                return { mapped: false, code: "AE_LAYER_INDEX_MAPPING_UNAVAILABLE", details: { sourceLayerId: referenceLayer.id } };
            }
            if (source.propertyValueType === PropertyValueType.MASK_INDEX) {
                sourceMasks = sourceLayer.property("ADBE Mask Parade");
                targetMasks = targetLayer.property("ADBE Mask Parade");
                sourceMask = sourceMasks && sourceMasks.property(value);
                if (!sourceMask || !targetMasks) return { mapped: false, code: "AE_MASK_INDEX_MAPPING_UNAVAILABLE" };
                ordinal = occurrenceOrdinal(sourceMasks, sourceMask.propertyIndex, sourceMask.matchName, sourceMask.name);
                targetMask = findOccurrence(targetMasks, sourceMask.matchName, ordinal, sourceMask.name);
                if (targetMask) return { mapped: true, value: targetMask.propertyIndex };
                return { mapped: false, code: "AE_MASK_INDEX_MAPPING_UNAVAILABLE", details: { sourceMaskName: sourceMask.name } };
            }
        } catch (error) {
            return { mapped: false, code: "AE_REFERENCE_MAPPING_FAILED", details: { message: error.toString() } };
        }
        return { mapped: false, code: "AE_REFERENCE_MAPPING_UNSUPPORTED" };
    }

    function snapshotLeaf(source, sourceLayer, targetLayer, warnings) {
        var result = { value: null, keys: [], expression: null, expressionEnabled: false };
        try {
            if (typeof PropertyValueType !== "undefined" && source.propertyValueType === PropertyValueType.CUSTOM_VALUE) {
                result.opaque = true;
                result.propertyValueType = String(source.propertyValueType);
                return result;
            }
            if (typeof PropertyValueType !== "undefined" && (source.propertyValueType === PropertyValueType.LAYER_INDEX || source.propertyValueType === PropertyValueType.MASK_INDEX)) {
                var mappedReference = mapReferenceValue(source, sourceLayer, targetLayer);
                if (!mappedReference.mapped) {
                    result.opaque = true;
                    result.referenceWarningCode = mappedReference.code;
                    result.referenceDetails = mappedReference.details || {};
                    result.propertyValueType = String(source.propertyValueType);
                    return result;
                }
                result.value = mappedReference.value;
                result.referenceMapped = true;
            }
        } catch (ignoreValueType) {}
        if (!result.referenceMapped) {
            try { result.value = source.valueAtTime(sourceLayer.inPoint, false); }
            catch (errorValueAtTime) {
                try { result.value = source.value; } catch (errorValue) { result.opaque = true; }
            }
        }
        try {
            for (var i = 1; i <= source.numKeys; i += 1) {
                var key = { time: source.keyTime(i), value: source.keyValue(i) };
                if (result.referenceMapped) {
                    var mappedKey = mapReferenceValue(source, sourceLayer, targetLayer, key.value);
                    if (!mappedKey.mapped) {
                        warnings.push({ code: mappedKey.code || "AE_REFERENCE_MAPPING_UNSUPPORTED", name: source.name, matchName: source.matchName, details: mappedKey.details || {} });
                        continue;
                    }
                    key.value = mappedKey.value;
                }
                try { key.inInterpolation = source.keyInInterpolationType(i); key.outInterpolation = source.keyOutInterpolationType(i); } catch (ignoreInterpolation) {}
                try { key.inEase = source.keyInTemporalEase(i); key.outEase = source.keyOutTemporalEase(i); } catch (ignoreEase) {}
                try { key.temporalContinuous = source.keyTemporalContinuous(i); key.temporalAutoBezier = source.keyTemporalAutoBezier(i); } catch (ignoreTemporal) {}
                try { key.inSpatialTangent = source.keyInSpatialTangent(i); key.outSpatialTangent = source.keyOutSpatialTangent(i); key.spatialContinuous = source.keySpatialContinuous(i); key.spatialAutoBezier = source.keySpatialAutoBezier(i); key.roving = source.keyRoving(i); } catch (ignoreSpatial) {}
                try { key.label = source.keyLabel(i); } catch (ignoreLabel) {}
                try { key.selected = source.keySelected(i); } catch (ignoreSelected) {}
                result.keys.push(key);
            }
        } catch (errorKeys) { warnings.push({ code: "AE_KEY_SNAPSHOT_FAILED", name: source.name, message: errorKeys.toString() }); }
        try { result.expressionEnabled = source.expressionEnabled; result.expression = source.expression; } catch (ignoreExpression) {}
        return result;
    }

    function scaledEase(eases, sourceLayer, targetLayer) {
        var result = [];
        if (!eases) return result;
        for (var i = 0; i < eases.length; i += 1) {
            result.push(new KeyframeEase($._LWS.scaleTemporalSpeed(eases[i].speed, sourceLayer.inPoint, sourceLayer.outPoint, targetLayer.inPoint, targetLayer.outPoint), eases[i].influence));
        }
        return result;
    }

    function copyLeaf(source, target, sourceLayer, targetLayer, warnings) {
        var snap = snapshotLeaf(source, sourceLayer, targetLayer, warnings);
        var copiedKeys = 0;
        if (snap.opaque) {
            warnings.push({ code: snap.referenceWarningCode || "AE_UNSUPPORTED_PROPERTY_VALUE", name: source.name, matchName: source.matchName, propertyValueType: snap.propertyValueType || null, details: snap.referenceDetails || {} });
            return false;
        }
        $._LWS.mapKeyTime(sourceLayer.inPoint, sourceLayer.inPoint, sourceLayer.outPoint, targetLayer.inPoint, targetLayer.outPoint);
        try { if (target.canSetExpression && target.expressionEnabled) target.expressionEnabled = false; } catch (ignoreTargetExpression) {}
        removeKeys(target);
        for (var i = 0; i < snap.keys.length; i += 1) {
            var key = snap.keys[i];
            if (key.time < sourceLayer.inPoint || key.time > sourceLayer.outPoint) continue;
            var targetTime = $._LWS.mapKeyTime(key.time, sourceLayer.inPoint, sourceLayer.outPoint, targetLayer.inPoint, targetLayer.outPoint);
            target.setValueAtTime(targetTime, key.value);
            var index = target.nearestKeyIndex(targetTime);
            copiedKeys += 1;
            try { target.setInterpolationTypeAtKey(index, key.inInterpolation, key.outInterpolation); } catch (ignoreInterpolation) {}
            try { target.setTemporalEaseAtKey(index, scaledEase(key.inEase, sourceLayer, targetLayer), scaledEase(key.outEase, sourceLayer, targetLayer)); } catch (ignoreEase) {}
            try { target.setTemporalContinuousAtKey(index, key.temporalContinuous); target.setTemporalAutoBezierAtKey(index, key.temporalAutoBezier); } catch (ignoreTemporal) {}
            try {
                target.setSpatialTangentsAtKey(index, key.inSpatialTangent, key.outSpatialTangent);
                target.setSpatialContinuousAtKey(index, key.spatialContinuous);
                target.setSpatialAutoBezierAtKey(index, key.spatialAutoBezier);
                if (index > 1 && index < target.numKeys) target.setRovingAtKey(index, key.roving);
            } catch (ignoreSpatial) {}
            try { if (target.setLabelAtKey && key.label !== undefined) target.setLabelAtKey(index, key.label); } catch (ignoreLabel) {}
            try { if (target.setSelectedAtKey && key.selected !== undefined) target.setSelectedAtKey(index, key.selected); } catch (ignoreSelected) {}
        }
        if (!copiedKeys) {
            try { target.setValue(snap.value); }
            catch (errorSet) { warnings.push({ code: "AE_PROPERTY_SET_FAILED", name: source.name, matchName: source.matchName, message: errorSet.toString() }); return false; }
        }
        try {
            if (snap.expressionEnabled && target.canSetExpression) {
                target.expression = snap.expression;
                target.expressionEnabled = true;
                warnings.push({ code: "AE_EXPRESSION_COPIED_UNCHANGED", name: source.name, matchName: source.matchName, sourceLayerId: sourceLayer.id, targetLayerId: targetLayer.id });
            }
        } catch (errorExpression) { warnings.push({ code: "AE_EXPRESSION_COPY_FAILED", name: source.name, message: errorExpression.toString() }); }
        return true;
    }

    function occurrenceOrdinal(group, propertyIndex, matchName, displayName) {
        var ordinal = 0;
        for (var i = 1; i <= propertyIndex && i <= group.numProperties; i += 1) {
            var candidate = group.property(i);
            if (candidate.matchName === matchName && (displayName === undefined || candidate.name === displayName)) ordinal += 1;
        }
        return ordinal;
    }

    function findOccurrence(group, matchName, ordinal, displayName) {
        var count = 0;
        for (var i = 1; i <= group.numProperties; i += 1) {
            var candidate = group.property(i);
            if (candidate.matchName === matchName && (displayName === undefined || candidate.name === displayName)) {
                count += 1;
                if (count === ordinal) return candidate;
            }
        }
        return null;
    }

    function copyGroupAttributes(source, target) {
        var fields = ["maskMode", "inverted", "rotoBezier", "maskMotionBlur", "color"];
        try { target.name = source.name; } catch (ignoreName) {}
        try { target.enabled = source.enabled; } catch (ignoreEnabled) {}
        for (var i = 0; i < fields.length; i += 1) {
            try { target[fields[i]] = source[fields[i]]; } catch (ignoreAttribute) {}
        }
    }

    function findOrCreateChild(sourceGroup, targetGroup, sourceChild, warnings) {
        var targetChild = null;
        var ordinal = occurrenceOrdinal(sourceGroup, sourceChild.propertyIndex, sourceChild.matchName);
        try {
            targetChild = targetGroup.property(sourceChild.propertyIndex);
            if (targetChild && targetChild.matchName !== sourceChild.matchName) targetChild = null;
        } catch (ignoreIndex) { targetChild = null; }
        if (!targetChild) try { targetChild = findOccurrence(targetGroup, sourceChild.matchName, ordinal); } catch (ignoreOccurrence) {}
        if (!targetChild) {
            try {
                if (targetGroup.canAddProperty(sourceChild.matchName)) targetChild = targetGroup.addProperty(sourceChild.matchName);
            } catch (ignoreAdd) {}
        }
        if (!targetChild) warnings.push({ code: "AE_PROPERTY_TARGET_MISSING", name: sourceChild.name, matchName: sourceChild.matchName });
        return targetChild;
    }

    function copyGroup(source, target, sourceLayer, targetLayer, warnings) {
        copyGroupAttributes(source, target);
        for (var i = 1; i <= source.numProperties; i += 1) {
            var sourceChild = source.property(i);
            var targetChild = findOrCreateChild(source, target, sourceChild, warnings);
            var isLeaf = false;
            if (!targetChild) continue;
            try { isLeaf = sourceChild.propertyType === PropertyType.PROPERTY; }
            catch (ignorePropertyType) { try { isLeaf = sourceChild.propertyValueType !== undefined; } catch (ignoreValueType) {} }
            if (isLeaf) copyLeaf(sourceChild, targetChild, sourceLayer, targetLayer, warnings);
            else copyGroup(sourceChild, targetChild, sourceLayer, targetLayer, warnings);
        }
        try { if (source.locked !== undefined) target.locked = source.locked; } catch (ignoreLocked) {}
    }

    function replaceIndexedModule(sourceModule, sourceParent, targetParent, addMatchName, sourceLayer, targetLayer, warnings, missingCode) {
        var ordinal = occurrenceOrdinal(sourceParent, sourceModule.propertyIndex, sourceModule.matchName, sourceModule.name);
        var existing = findOccurrence(targetParent, sourceModule.matchName, ordinal, sourceModule.name);
        var targetIndex = existing ? existing.propertyIndex : Math.min(sourceModule.propertyIndex, targetParent.numProperties + 1);
        var targetModule = null;
        try {
            if (!targetParent.canAddProperty(addMatchName || sourceModule.matchName)) {
                warnings.push({ code: missingCode, name: sourceModule.name, matchName: sourceModule.matchName, sourceLayerId: sourceLayer.id, targetLayerId: targetLayer.id });
                return false;
            }
        } catch (ignoreCanAdd) {}
        try { targetModule = targetParent.addProperty(addMatchName || sourceModule.matchName); }
        catch (errorAdd) {
            warnings.push({ code: missingCode, name: sourceModule.name, matchName: sourceModule.matchName, sourceLayerId: sourceLayer.id, targetLayerId: targetLayer.id, message: errorAdd.toString() });
            return false;
        }
        try {
            copyGroupAttributes(sourceModule, targetModule);
            copyGroup(sourceModule, targetModule, sourceLayer, targetLayer, warnings);
        } catch (errorCopy) {
            try { targetParent.property(targetParent.numProperties).remove(); } catch (ignorePartialRemove) {}
            throw errorCopy;
        }
        try {
            if (existing) {
                targetParent.property(targetIndex).remove();
            }
            targetModule = targetParent.property(targetParent.numProperties);
            if (targetModule && targetModule.moveTo && targetIndex <= targetParent.numProperties) {
                targetModule.moveTo(targetIndex);
                targetModule = targetParent.property(targetIndex);
            }
        } catch (ignoreMove) {}
        return true;
    }

    function copyTextStyle(sourceLayer, targetLayer, warnings) {
        var sourceProp = textSource(sourceLayer);
        var targetProp = textSource(targetLayer);
        var i;
        if (!sourceProp || !targetProp) return false;
        try {
            if (targetProp.expressionEnabled) {
                warnings.push({ code: "AE_TEXT_STYLE_EXPRESSION_CONFLICT", targetLayerId: targetLayer.id });
                return false;
            }
        } catch (ignoreTargetExpression) {}
        try {
            if (sourceProp.expressionEnabled) warnings.push({ code: "AE_SOURCE_TEXT_EXPRESSION_NOT_COPIED", sourceLayerId: sourceLayer.id });
        } catch (ignoreSourceExpression) {}
        try {
            if (sourceProp.numKeys > 0) {
                var entries = {};
                var ordered = [];
                var boundaryDocument = sourceProp.valueAtTime(sourceLayer.inPoint, false);
                boundaryDocument.text = targetProp.valueAtTime(targetLayer.inPoint, false).text;
                entries[String(Math.round(targetLayer.inPoint * 1000000))] = { time: targetLayer.inPoint, document: boundaryDocument };
                for (i = 1; i <= sourceProp.numKeys; i += 1) {
                    var sourceTime = sourceProp.keyTime(i);
                    if (sourceTime < sourceLayer.inPoint || sourceTime > sourceLayer.outPoint) continue;
                    var mappedTime = $._LWS.mapKeyTime(sourceTime, sourceLayer.inPoint, sourceLayer.outPoint, targetLayer.inPoint, targetLayer.outPoint);
                    var sourceDocument = sourceProp.keyValue(i);
                    sourceDocument.text = targetProp.valueAtTime(mappedTime, false).text;
                    var sourceKey = String(Math.round(mappedTime * 1000000));
                    entries[sourceKey] = { time: mappedTime, document: sourceDocument };
                }
                for (i = 1; i <= targetProp.numKeys; i += 1) {
                    var targetTime = targetProp.keyTime(i);
                    var sampledSourceTime = $._LWS.mapKeyTime(targetTime, targetLayer.inPoint, targetLayer.outPoint, sourceLayer.inPoint, sourceLayer.outPoint);
                    var styledDocument = sourceProp.valueAtTime(sampledSourceTime, false);
                    styledDocument.text = targetProp.keyValue(i).text;
                    var targetKey = String(Math.round(targetTime * 1000000));
                    entries[targetKey] = { time: targetTime, document: styledDocument };
                }
                for (var entryKey in entries) if (Object.prototype.hasOwnProperty.call(entries, entryKey)) ordered.push(entries[entryKey]);
                ordered.sort(function (a, b) { return a.time - b.time; });
                removeKeys(targetProp);
                for (i = 0; i < ordered.length; i += 1) targetProp.setValueAtTime(ordered[i].time, ordered[i].document);
                try { for (i = 1; i <= targetProp.numKeys; i += 1) targetProp.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (ignoreHold) {}
            } else {
                if (targetProp.numKeys > 0) {
                    for (i = 1; i <= targetProp.numKeys; i += 1) {
                        var targetText = targetProp.keyValue(i).text;
                        var keyedDocument = sourceProp.valueAtTime(sourceLayer.inPoint, false);
                        keyedDocument.text = targetText;
                        targetProp.setValueAtKey(i, keyedDocument);
                    }
                } else {
                    var currentText = targetProp.value.text;
                    var document = sourceProp.valueAtTime(sourceLayer.inPoint, false);
                    document.text = currentText;
                    targetProp.setValue(document);
                }
            }
            return true;
        } catch (errorTextStyle) {
            warnings.push({ code: "AE_TEXT_STYLE_COPY_FAILED", sourceLayerId: sourceLayer.id, targetLayerId: targetLayer.id, message: errorTextStyle.toString() });
            return false;
        }
    }

    function copySelectedModules(sourceLayer, targetLayer, moduleIds, warnings) {
        var copyAll = moduleIds === undefined || moduleIds === null;
        var wanted = {};
        var copiedCount = 0;
        var i;
        if (moduleIds) for (i = 0; i < moduleIds.length; i += 1) wanted[moduleIds[i]] = true;

        var effects = sourceLayer.property("ADBE Effect Parade");
        var targetEffects = targetLayer.property("ADBE Effect Parade");
        if (effects && targetEffects) for (i = effects.numProperties; i >= 1; i -= 1) {
            var effect = effects.property(i);
            var effectId = "effect:" + i + ":" + effect.matchName;
            if ((copyAll || wanted[effectId]) && replaceIndexedModule(effect, effects, targetEffects, effect.matchName, sourceLayer, targetLayer, warnings, "AE_THIRD_PARTY_EFFECT_MISSING")) copiedCount += 1;
        }

        var sourceTextProperties = sourceLayer.property("ADBE Text Properties");
        var targetTextProperties = targetLayer.property("ADBE Text Properties");
        var animators = sourceTextProperties && sourceTextProperties.property("ADBE Text Animators");
        var targetAnimators = targetTextProperties && targetTextProperties.property("ADBE Text Animators");
        if (animators && targetAnimators) for (i = animators.numProperties; i >= 1; i -= 1) {
            var animator = animators.property(i);
            var animatorId = "animator:" + i + ":" + animator.matchName;
            if ((copyAll || wanted[animatorId]) && replaceIndexedModule(animator, animators, targetAnimators, animator.matchName, sourceLayer, targetLayer, warnings, "AE_ANIMATOR_COPY_FAILED")) copiedCount += 1;
        }

        var masks = sourceLayer.property("ADBE Mask Parade");
        var targetMasks = targetLayer.property("ADBE Mask Parade");
        if (masks && targetMasks) for (i = masks.numProperties; i >= 1; i -= 1) {
            var mask = masks.property(i);
            var maskId = "mask:" + i + ":" + mask.matchName;
            if ((copyAll || wanted[maskId]) && replaceIndexedModule(mask, masks, targetMasks, mask.matchName, sourceLayer, targetLayer, warnings, "AE_MASK_COPY_FAILED")) copiedCount += 1;
        }

        if (copyAll || wanted.transform) {
            var sourceTransform = sourceLayer.property("ADBE Transform Group");
            var targetTransform = targetLayer.property("ADBE Transform Group");
            if (sourceTransform && targetTransform) { copyGroup(sourceTransform, targetTransform, sourceLayer, targetLayer, warnings); copiedCount += 1; }
        }
        if ((copyAll || wanted.textStyle) && isTextLayer(sourceLayer) && isTextLayer(targetLayer) && copyTextStyle(sourceLayer, targetLayer, warnings)) copiedCount += 1;

        var styles = sourceLayer.property("ADBE Layer Styles");
        var targetStyles = targetLayer.property("ADBE Layer Styles");
        if (styles && targetStyles) for (i = 1; i <= styles.numProperties; i += 1) {
            var style = styles.property(i);
            var styleId = "layerStyle:" + i + ":" + style.matchName;
            if (copyAll || wanted[styleId]) {
                var targetStyle = findOccurrence(targetStyles, style.matchName, occurrenceOrdinal(styles, i, style.matchName));
                if (!targetStyle) {
                    try { if (targetStyles.canAddProperty(style.matchName)) targetStyle = targetStyles.addProperty(style.matchName); } catch (ignoreStyleAdd) {}
                }
                if (targetStyle) { copyGroup(style, targetStyle, sourceLayer, targetLayer, warnings); copiedCount += 1; }
                else warnings.push({ code: "AE_LAYER_STYLE_COPY_UNSUPPORTED", name: style.name, matchName: style.matchName, targetLayerId: targetLayer.id });
            }
        }
        return copiedCount;
    }

    $._LWS.register("common.capabilities", function () {
        var supported = $._LWS.versionInfo().supported;
        return { data: { host: "AEFT", version: String(app.version), supported: supported, features: { audioExport: supported, fonts: !!(supported && app.fonts && app.fonts.allFonts), aepImport: supported, textLayers: supported, propertyTree: supported, moduleCopy: supported, perSegmentLayers: supported, singleLayer: supported } } };
    });

    $._LWS.register("ae.context.get", function () {
        var comp = activeComp();
        if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成");
        return { data: { projectPath: app.project.file ? app.project.file.fsName : null, activeComp: { itemId: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, frameDuration: comp.frameDuration, displayStartTime: comp.displayStartTime, workAreaStart: comp.workAreaStart, workAreaDuration: comp.workAreaDuration } } };
    });

    $._LWS.register("ae.range.get", function () {
        var comp = activeComp();
        if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成");
        if (!(comp.workAreaDuration > 0)) return fail("AE_INVALID_RANGE", "工作区时长无效");
        return { data: { timeBase: "compSeconds", start: comp.workAreaStart, end: comp.workAreaStart + comp.workAreaDuration, duration: comp.workAreaDuration } };
    });

    $._LWS.register("ae.fonts.list", function () {
        var fonts = [];
        var warnings = [];
        try {
            var groups = app.fonts.allFonts;
            for (var i = 0; i < groups.length; i += 1) {
                var group = groups[i] instanceof Array ? groups[i] : [groups[i]];
                for (var j = 0; j < group.length; j += 1) {
                    var font = group[j];
                    try { fonts.push({ postScriptName: font.postScriptName, familyName: font.familyName, styleName: font.styleName, technology: String(font.technology || "") }); } catch (fontError) { warnings.push({ code: "AE_FONT_READ_FAILED", index: i + ":" + j }); }
                }
            }
        } catch (error) { return fail("AE_FONT_ENUM_FAILED", "无法读取 AE 字体库", { message: error.toString() }); }
        return { data: { fonts: fonts }, warnings: warnings };
    });

    $._LWS.register("ae.selection.snapshot", function () {
        var comp = activeComp();
        if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成");
        var layers = [];
        var selected = comp.selectedLayers;
        for (var i = 0; i < selected.length; i += 1) layers.push(layerRef(selected[i], comp));
        layers.sort(function (a, b) { return a.index - b.index; });
        return { data: { compId: comp.id, layers: layers } };
    });

    $._LWS.register("ae.aep.import", function (params) {
        if (!app.project) return fail("NO_PROJECT", "没有活动工程");
        if (!params.path || !/\.ae[pt]$/i.test(String(params.path))) return fail("INVALID_REQUEST", "模板必须是 .aep 或 .aet 文件", { path: params.path || null });
        var file = new File(params.path);
        if (!file.exists) return fail("FILE_NOT_FOUND", "AEP 文件不存在", { path: params.path });
        var before = {};
        for (var i = 1; i <= app.project.numItems; i += 1) before[app.project.item(i).id] = true;
        app.beginUndoGroup("LWS 导入字幕模板");
        try {
            var options = new ImportOptions(file);
            if (options.canImportAs && options.canImportAs(ImportAsType.PROJECT)) options.importAs = ImportAsType.PROJECT;
            app.project.importFile(options);
            var comps = [];
            var importedIds = [];
            for (i = 1; i <= app.project.numItems; i += 1) {
                var item = app.project.item(i);
                if (!before[item.id]) importedIds.push(item.id);
                if (!before[item.id] && item instanceof CompItem) {
                    var count = 0;
                    for (var l = 1; l <= item.numLayers; l += 1) if (isTextLayer(item.layer(l))) count += 1;
                    comps.push({ compId: item.id, name: item.name, width: item.width, height: item.height, duration: item.duration, textLayerCount: count });
                }
            }
            var sessionId = "ae-import-" + (new Date()).getTime() + "-" + Math.floor(Math.random() * 1000000);
            $._LWS.aepImports[sessionId] = importedIds;
            return { data: { importSessionId: sessionId, comps: comps } };
        } catch (error) { return fail("AE_AEP_IMPORT_FAILED", "AEP 导入失败", { message: error.toString() }); }
        finally { app.endUndoGroup(); }
    });

    $._LWS.register("ae.aep.listComps", function (params) {
        if (!app.project) return fail("NO_PROJECT", "没有活动工程");
        var allowed = null;
        if (params.importSessionId) {
            var ids = $._LWS.aepImports[params.importSessionId];
            if (!ids) return fail("AE_IMPORT_SESSION_NOT_FOUND", "找不到 AEP 导入会话", { importSessionId: params.importSessionId });
            allowed = {};
            for (var a = 0; a < ids.length; a += 1) allowed[ids[a]] = true;
        }
        var comps = [];
        for (var i = 1; i <= app.project.numItems; i += 1) {
            var item = app.project.item(i);
            if (item instanceof CompItem && (!allowed || allowed[item.id])) {
                var count = 0;
                for (var l = 1; l <= item.numLayers; l += 1) if (isTextLayer(item.layer(l))) count += 1;
                if (count) comps.push({ compId: item.id, name: item.name, width: item.width, height: item.height, duration: item.duration, textLayerCount: count });
            }
        }
        return { data: { comps: comps } };
    });

    $._LWS.register("ae.comp.listTextLayers", function (params) {
        var comp = compById(params.compId);
        if (!comp) return fail("AE_COMP_NOT_FOUND", "找不到指定合成", { compId: params.compId });
        var layers = [];
        for (var i = 1; i <= comp.numLayers; i += 1) if (isTextLayer(comp.layer(i))) layers.push(layerRef(comp.layer(i), comp));
        return { data: { compId: comp.id, layers: layers } };
    });

    $._LWS.register("ae.layer.tree", function (params, request) {
        var comp = compById(params.compId);
        var layer = layerById(comp, params.layerId);
        if (!layer) return fail("AE_LAYER_NOT_FOUND", "找不到指定图层", { compId: params.compId, layerId: params.layerId });
        var warnings = [];
        var sampleTime = params.sampleTime !== undefined ? Number(params.sampleTime) : layer.inPoint;
        var tree = serializeProperty(layer, [], 0, warnings, sampleTime);
        var data = { compId: comp.id, layerId: layer.id, tree: tree };
        var serialized = JSON.stringify(data);
        if (params.responseFile || serialized.length > 262144) {
            var safeRequestId = String(request.requestId || (new Date()).getTime()).replace(/[^A-Za-z0-9_.-]/g, "_");
            var responsePath = params.responseFile || (Folder.temp.fsName + "/LocalWhisper-tree-" + safeRequestId + ".json");
            $._LWS.writeJsonFile(responsePath, data);
            data = { transport: "jsonFile", path: new File(responsePath).fsName, characterLength: serialized.length };
        } else data = { transport: "inline", value: data };
        return { data: data, warnings: warnings };
    });

    $._LWS.register("ae.audio.export", function (params) {
        var comp = compById(params.compId) || activeComp();
        if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成");
        if (!isFinite(Number(params.start)) || !isFinite(Number(params.end)) || !(Number(params.end) > Number(params.start))) return fail("AE_INVALID_RANGE", "音频源范围无效");
        if (Number(params.start) < 0 || Number(params.end) > comp.duration + comp.frameDuration) return fail("AE_INVALID_RANGE", "音频导出范围超出合成时长", { start: Number(params.start), end: Number(params.end), compDuration: comp.duration });
        var start = Number(params.start);
        var end = Number(params.end);
        var hasLayerFilter = params.layerIds !== undefined && params.layerIds !== null;
        var requested = {};
        var requestedOrder = {};
        var missingLayerIds = [];
        var unsupportedTimeRemapIds = [];
        var layerIds;
        if (hasLayerFilter) {
            if (!(params.layerIds instanceof Array) || !params.layerIds.length) return fail("AE_AUDIO_LAYER_SELECTION_REQUIRED", "请先选择至少一个音频或视频图层");
            layerIds = params.layerIds;
            for (var selectedIndex = 0; selectedIndex < layerIds.length; selectedIndex += 1) {
                requested[String(Number(layerIds[selectedIndex]))] = true;
                requestedOrder[String(Number(layerIds[selectedIndex]))] = selectedIndex;
            }
        }
        var candidates = [];
        var i;
        for (i = 1; i <= comp.numLayers; i += 1) {
            var layer = comp.layer(i);
            var source = null;
            var file = null;
            try {
                if (hasLayerFilter && !requested[String(layer.id)]) continue;
                if (!layer || layer.enabled === false || !(layer.hasAudio === true || layer.audioEnabled === true)) continue;
                if (layer.outPoint <= start || layer.inPoint >= end) continue;
                if (layer.timeRemapEnabled === true) {
                    unsupportedTimeRemapIds.push(layer.id);
                    continue;
                }
                source = layer.source;
                if (source && source.mainSource && source.mainSource.file) file = source.mainSource.file;
                if (!file && source && source.file) file = source.file;
                if (!file || !file.exists) {
                    if (hasLayerFilter) missingLayerIds.push(layer.id);
                    continue;
                }
                var stretch = Number(layer.stretch);
                if (!isFinite(stretch) || stretch === 0) stretch = 100;
                var overlapStart = Math.max(start, Number(layer.inPoint));
                var overlapEnd = Math.min(end, Number(layer.outPoint));
                // File seeking is relative to the media start, not its displayed timecode.
                var sourceAtStart = (overlapStart - Number(layer.startTime)) * 100 / stretch;
                var sourceAtEnd = (overlapEnd - Number(layer.startTime)) * 100 / stretch;
                var sourceStart = Math.min(sourceAtStart, sourceAtEnd);
                var sourceEnd = Math.max(sourceAtStart, sourceAtEnd);
                if (!(sourceEnd > sourceStart)) continue;
                candidates.push({ path: file.fsName, sourceStartMs: Math.max(0, sourceStart * 1000), sourceEndMs: Math.max(0, sourceEnd * 1000), timelineInMs: Math.round(overlapStart * 1000), timelineOutMs: Math.round(overlapEnd * 1000), playbackRate: Math.abs(100 / stretch), reverse: sourceAtEnd < sourceAtStart, layerId: layer.id, layerName: layer.name, layerIndex: layer.index });
            } catch (ignoreLayer) {}
        }
        if (!candidates.length && unsupportedTimeRemapIds.length) return fail("AE_TIME_REMAP_UNSUPPORTED", "选中图层启用了时间重映射，无法从源文件准确还原非线性音频时间", { layerIds: unsupportedTimeRemapIds });
        if (!candidates.length) return fail("AE_AUDIO_SOURCE_NOT_FOUND", "选中的音频/视频图层没有可直接读取的源文件；请确认它是导入的媒体素材，而不是文字、特效或预合成", { start: start, end: end, layerIds: hasLayerFilter ? layerIds : [] });
        if (hasLayerFilter) candidates.sort(function (a, b) { return requestedOrder[String(a.layerId)] - requestedOrder[String(b.layerId)]; });
        var warnings = [];
        if (missingLayerIds.length) warnings.push({ code: "AE_AUDIO_LAYER_SOURCE_NOT_FOUND", layerIds: missingLayerIds });
        if (unsupportedTimeRemapIds.length) warnings.push({ code: "AE_TIME_REMAP_UNSUPPORTED", layerIds: unsupportedTimeRemapIds });
        var data = { sources: candidates, count: candidates.length };
        if (candidates.length === 1) {
            data.path = candidates[0].path;
            data.sourceStartMs = candidates[0].sourceStartMs;
            data.sourceEndMs = candidates[0].sourceEndMs;
            data.timelineInMs = candidates[0].timelineInMs;
            data.timelineOutMs = candidates[0].timelineOutMs;
            data.layerId = candidates[0].layerId;
            data.layerName = candidates[0].layerName;
        }
        return { data: data, warnings: warnings };
    });

    $._LWS.register("ae.subtitles.create", function (params) {
        var comp = compById(params.compId) || activeComp();
        if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成");
        var payload = params.segmentsFile ? $._LWS.readJsonFile(params.segmentsFile) : { segments: params.segments || [] };
        var segments = payload.segments || [];
        var warnings = [];
        var created = [];
        app.beginUndoGroup("LWS 生成字幕");
        try {
            created = params.mode === "singleLayer" ? createSingleLayer(params, comp, segments, warnings) : createPerSegment(params, comp, segments, warnings);
        } catch (error) { return fail("AE_ALL_ITEMS_FAILED", "AE 字幕生成失败", { message: error.toString() }, warnings); }
        finally { app.endUndoGroup(); }
        if (!created.length && segments.length) return fail("AE_ALL_ITEMS_FAILED", "没有成功创建字幕", {}, warnings);
        return { data: { created: created, count: created.length }, warnings: warnings };
    });

    $._LWS.register("ae.modules.copy", function (params) {
        var warnings = [];
        var copied = [];
        if (!params.sources || !params.sources.length || !params.targets || !params.targets.length) return fail("INVALID_REQUEST", "来源和目标不能为空");
        var sourceKeys = {};
        for (var s = 0; s < params.sources.length; s += 1) sourceKeys[String(params.sources[s].compId) + ":" + String(params.sources[s].layerId)] = true;
        app.beginUndoGroup("LWS 复制文本效果");
        try {
            for (var i = 0; i < params.targets.length; i += 1) {
                var sourceRef = params.sources[i % params.sources.length];
                var targetRef = params.targets[i];
                var sourceComp = compById(sourceRef.compId);
                var targetComp = compById(targetRef.compId);
                var source = layerById(sourceComp, sourceRef.layerId);
                var target = layerById(targetComp, targetRef.layerId);
                if (sourceKeys[String(targetRef.compId) + ":" + String(targetRef.layerId)]) { warnings.push({ code: "AE_COPY_TARGET_IS_SOURCE", targetLayerId: targetRef.layerId }); continue; }
                if (!source || !target) { warnings.push({ code: "AE_LAYER_NOT_FOUND", sourceLayerId: sourceRef.layerId, targetLayerId: targetRef.layerId }); continue; }
                if (!(source.outPoint > source.inPoint) || !(target.outPoint > target.inPoint)) { warnings.push({ code: "AE_INVALID_LAYER_DURATION", sourceLayerId: source.id, targetLayerId: target.id }); continue; }
                try {
                    var moduleCount = copySelectedModules(source, target, sourceRef.moduleIds || params.moduleIds, warnings);
                    if (moduleCount > 0) copied.push({ sourceLayerId: source.id, targetLayerId: target.id, moduleCount: moduleCount });
                    else warnings.push({ code: "AE_NO_MODULES_COPIED", sourceLayerId: source.id, targetLayerId: target.id });
                }
                catch (copyError) { warnings.push({ code: "AE_MODULE_COPY_FAILED", sourceLayerId: source.id, targetLayerId: target.id, message: copyError.toString() }); }
            }
        } finally { app.endUndoGroup(); }
        if (!copied.length) return fail("AE_ALL_ITEMS_FAILED", "没有成功复制任何效果", {}, warnings);
        return { data: { copied: copied, count: copied.length }, warnings: warnings };
    });
}());
