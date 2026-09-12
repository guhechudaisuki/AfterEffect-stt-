/* Independent whole-composition text replacement for After Effects 2020+.
 * The v3.0.0 effect-copy routes are deliberately not touched here. ExtendScript ES3 only. */
(function () {
    var sourceRefs = [], nextSourceToken = 1;
    function fail(code, message, details, warnings) { return { ok: false, error: $._LWS.errorObject(code, message, details || {}), warnings: warnings || [] }; }
    function compById(id) { if (!app.project) return null; for (var i = 1; i <= app.project.numItems; i += 1) { var item = app.project.item(i); if (item instanceof CompItem && item.id === Number(id)) return item; } return null; }
    function activeComp() { return app.project && app.project.activeItem instanceof CompItem ? app.project.activeItem : null; }
    function isText(layer) { try { return !!(layer && layer.property("ADBE Text Properties")); } catch (ignore) { return false; } }
    function textProp(layer) { var group = layer && layer.property("ADBE Text Properties"); return group ? group.property("ADBE Text Document") : null; }
    function textValue(layer) { var prop = textProp(layer); if (!prop) return null; try { return prop.value && prop.value.text !== undefined ? String(prop.value.text) : ""; } catch (ignore) { return null; } }
    function rememberSource(layer, comp) { for (var i = 0; i < sourceRefs.length; i += 1) if (sourceRefs[i].compId === comp.id && sourceRefs[i].layer === layer) return sourceRefs[i].token; var ref = { token: "lws-source-" + (nextSourceToken += 1), compId: comp.id, layer: layer, layerId: Number(layer.id) || 0, index: layer.index, name: layer.name, text: textValue(layer) }; sourceRefs.push(ref); return ref.token; }
    function sourceByToken(token, comp) { for (var i = 0; i < sourceRefs.length; i += 1) { var ref = sourceRefs[i]; if (ref.token !== String(token) || ref.compId !== comp.id) continue; for (var j = 1; j <= comp.numLayers; j += 1) if (comp.layer(j) === ref.layer) return comp.layer(j); if (ref.layerId) for (j = 1; j <= comp.numLayers; j += 1) if (Number(comp.layer(j).id) === ref.layerId) return comp.layer(j); for (j = 1; j <= comp.numLayers; j += 1) { var candidate = comp.layer(j); if (candidate && candidate.name === ref.name && isText(candidate) && (ref.text === null || textValue(candidate) === ref.text)) return candidate; } } return null; }
    function layerRef(layer, comp, textOnly) { if (textOnly && !isText(layer)) return null; return { compId: comp.id, layerId: rememberSource(layer, comp), index: layer.index, name: layer.name, isText: isText(layer) }; }
    function outputFolder() { for (var i = 1; i <= app.project.numItems; i += 1) if (app.project.item(i) instanceof FolderItem && app.project.item(i).name === "LWS 合成复制") return app.project.item(i); return app.project.items.addFolder("LWS 合成复制"); }

    function walkText(comp, path, result, seen) {
        if (!comp || seen[comp.id]) return; seen[comp.id] = true;
        for (var i = 1; i <= comp.numLayers; i += 1) { var layer = comp.layer(i), next = path.concat([i]); if (isText(layer)) result.push({ compId: comp.id, index: i, name: layer.name, path: next, text: textValue(layer) }); try { if (layer.source instanceof CompItem) walkText(layer.source, next, result, seen); } catch (ignoreSource) {} }
    }
    function textSlots(comp) { var result = []; walkText(comp, [], result, {}); return result; }
    function layerAtPath(comp, path) { var current = comp; for (var i = 0; i < path.length; i += 1) { if (!current || !(current instanceof CompItem) || path[i] > current.numLayers) return null; var layer = current.layer(path[i]); if (i === path.length - 1) return layer; current = layer.source; } return null; }
    function cloneGraph(comp, seen, names, copies) {
        if (!comp) return null; if (seen[comp.id]) return seen[comp.id]; var copy = comp.duplicate(); if (copies) copies.push(copy); seen[comp.id] = copy; names[comp.id] = { oldName: comp.name, newName: copy.name };
        for (var i = 1; i <= copy.numLayers; i += 1) try { var nested = copy.layer(i).source; if (nested instanceof CompItem) copy.layer(i).replaceSource(cloneGraph(nested, seen, names, copies), false); } catch (nestedError) { throw nestedError; }
        return copy;
    }
    function removeCopies(copies) { for (var i = copies.length - 1; i >= 0; i -= 1) try { copies[i].remove(); } catch (ignore) {} }
    function replaceCompReferences(expression, names) {
        var out = "", i = 0;
        while (i < expression.length) {
            var c = expression.charAt(i), n = expression.charAt(i + 1);
            if (c === "/" && n === "/") { var line = expression.indexOf("\n", i); if (line < 0) line = expression.length; out += expression.substring(i, line); i = line; continue; }
            if (c === "/" && n === "*") { var end = expression.indexOf("*/", i + 2); if (end < 0) end = expression.length - 2; end += 2; out += expression.substring(i, end); i = end; continue; }
            if (c === "\"" || c === "'") { var quote = c, start = i; i += 1; while (i < expression.length) { if (expression.charAt(i) === "\\") { i += 2; continue; } if (expression.charAt(i) === quote) { i += 1; break; } i += 1; } out += expression.substring(start, i); continue; }
            if (expression.substr(i, 5) === "comp(") { var p = i + 5; while (/\s/.test(expression.charAt(p))) p += 1; var q = expression.charAt(p); if (q === "\"" || q === "'") { var e = p + 1; while (e < expression.length && expression.charAt(e) !== q) { if (expression.charAt(e) === "\\") e += 1; e += 1; } var literal = expression.substring(p + 1, e), replacement = literal; for (var id in names) if (names[id].oldName === literal) { replacement = names[id].newName; break; } out += expression.substring(i, p + 1) + replacement + q; i = e + 1; continue; } }
            out += c; i += 1;
        }
        return out;
    }
    function warningData(names) { return { names: names || {}, seen: {}, expressionCount: 0, selectorCount: 0, propertyCount: 0, expressionRestored: 0, failedWrites: 0, messages: [] }; }
    function adaptPropertyGroup(group, oldLength, newLength, warnings) {
        if (!group || !group.numProperties) return;
        var units = null;
        try { units = group.property("ADBE Text Range Units"); } catch (ignoreUnits) {}
        var indexUnits = !!units && Number(units.value) === 1;
        for (var i = 1; i <= group.numProperties; i += 1) { var prop = group.property(i); if (!prop) continue;
            try { if (prop.expression && prop.expressionEnabled) { var rewritten = replaceCompReferences(String(prop.expression), warnings.names); if (rewritten !== prop.expression) prop.expression = rewritten; warnings.expressionCount += 1; } var match = String(prop.matchName || ""); if (indexUnits && (match === "ADBE Text Index End" || match === "ADBE Text Index Start") && oldLength > 0) { var ratio = newLength / oldLength; if (prop.numKeys) for (var k = 1; k <= prop.numKeys; k += 1) { var indexed = Number(prop.keyValue(k)) * ratio; if (indexed < 0) indexed = 0; if (indexed > newLength) indexed = newLength; prop.setValueAtKey(k, indexed); } else { var indexedValue = Number(prop.value) * ratio; if (indexedValue < 0) indexedValue = 0; if (indexedValue > newLength) indexedValue = newLength; prop.setValue(indexedValue); } warnings.selectorCount += 1; } } catch (ignoreProperty) { warnings.propertyCount += 1; }
            try { if (prop.numProperties) adaptPropertyGroup(prop, oldLength, newLength, warnings); } catch (ignoreGroup) {}
        }
    }
    function adaptGraph(comp, warnings, oldLengths, path) {
        if (!comp || warnings.seen[comp.id]) return; warnings.seen[comp.id] = true;
        path = path || [];
        for (var i = 1; i <= comp.numLayers; i += 1) { var layer = comp.layer(i), next = path.concat([i]), oldText = textValue(layer); if (oldText !== null) { var prop = textProp(layer), current = prop && prop.value ? String(prop.value.text) : oldText, oldLength = oldLengths[next.join(".")] !== undefined ? oldLengths[next.join(".")] : oldText.length; adaptPropertyGroup(layer, oldLength, current.length, warnings); } else adaptPropertyGroup(layer, 0, 0, warnings); try { if (layer.source instanceof CompItem) adaptGraph(layer.source, warnings, oldLengths, next); } catch (ignoreSource) {} }
    }
    function writeText(layer, value, warnings) {
        var prop = textProp(layer); if (!prop) return false; var expression = "", expressionEnabled = false, locked = false;
        try { expression = String(prop.expression || ""); expressionEnabled = !!prop.expressionEnabled; } catch (ignoreExpression) {}
        try { locked = !!layer.locked; if (locked) layer.locked = false; if (expressionEnabled) prop.expressionEnabled = false; if (prop.numKeys) for (var k = 1; k <= prop.numKeys; k += 1) { var doc = prop.keyValue(k); doc.text = String(value); prop.setValueAtKey(k, doc); } else { var current = prop.value; if (!current) current = new TextDocument(String(value)); current.text = String(value); prop.setValue(current); } if (expression) { prop.expression = expression; prop.expressionEnabled = false; warnings.messages.push({ code: "W_COMP_COPY_SOURCE_TEXT_EXPRESSION_DISABLED", layer: layer.name }); } if (locked) layer.locked = true; return true; }
        catch (error) { try { if (expression) { prop.expression = expression; prop.expressionEnabled = expressionEnabled; } if (locked) layer.locked = true; } catch (ignoreRestore) {} warnings.failedWrites += 1; warnings.messages.push({ code: "AE_COMP_COPY_TEXT_SET_FAILED", layer: layer.name, message: error.toString() }); return false; }
    }

    $._LWS.register("ae.comp.copy.snapshot", function () { var comp = activeComp(); if (!comp) return fail("AE_NO_ACTIVE_COMP", "没有活动合成"); var layers = [], selected = comp.selectedLayers || []; for (var i = 0; i < selected.length; i += 1) { var ref = layerRef(selected[i], comp, true); if (ref) layers.push(ref); } layers.sort(function (a, b) { return a.index - b.index; }); return { data: { compId: comp.id, layers: layers } }; });
    $._LWS.register("ae.comp.copy.list", function (params) { var allowed = params && params.compIds, comps = []; for (var i = 1; i <= app.project.numItems; i += 1) { var item = app.project.item(i); if (!(item instanceof CompItem)) continue; if (allowed && allowed.length) { var found = false; for (var j = 0; j < allowed.length; j += 1) if (Number(allowed[j]) === item.id) found = true; if (!found) continue; } var slots = textSlots(item); if (slots.length) comps.push({ compId: item.id, name: item.name, width: item.width, height: item.height, duration: item.duration, textLayerCount: slots.length }); } return { data: { comps: comps } }; });
    $._LWS.register("ae.comp.copy.info", function (params) { var comp = compById(params.compId); if (!comp) return fail("AE_COMP_NOT_FOUND", "找不到指定合成", { compId: params.compId }); var slots = textSlots(comp), signature = ""; for (var i = 0; i < slots.length; i += 1) signature += slots[i].compId + ":" + slots[i].path.join(".") + ";"; return slots.length ? { data: { compId: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, textLayers: slots, signature: signature } } : fail("AE_COMP_COPY_NO_TEXT", "合成中没有文字图层", { compId: comp.id }); });
    $._LWS.register("ae.comp.copy.create", function (params) {
        var sourceComp = compById(params.sourceCompId), target = compById(params.targetCompId), template = compById(params.templateCompId), sourceTexts = [], slots, warnings = [], i;
        if (!sourceComp || !target) return fail("AE_COMP_COPY_COMP_NOT_FOUND", "找不到来源或目标合成"); if (!template) return fail("AE_COMP_COPY_TEMPLATE_NOT_FOUND", "找不到模板合成"); if (!(params.sourceLayerIds instanceof Array) || !params.sourceLayerIds.length) return fail("AE_COMP_COPY_SOURCES_REQUIRED", "请先记录至少一个来源文字图层");
        for (i = 0; i < params.sourceLayerIds.length; i += 1) { var source = sourceByToken(params.sourceLayerIds[i], sourceComp); if (!source || !isText(source)) return fail("AE_COMP_COPY_SOURCE_INVALID", "来源文字图层已失效", { token: params.sourceLayerIds[i] }); var value = textValue(source); if (value === null) return fail("AE_COMP_COPY_SOURCE_READ_FAILED", "无法读取来源文字", { token: params.sourceLayerIds[i] }); sourceTexts.push(value); }
        slots = textSlots(template); if (!slots.length) return fail("AE_COMP_COPY_NO_TEXT", "模板合成中没有文字图层");
        if (params.templateSignature) { var actual = ""; for (i = 0; i < slots.length; i += 1) actual += slots[i].compId + ":" + slots[i].path.join(".") + ";"; if (actual !== params.templateSignature) return fail("AE_COMP_COPY_TEMPLATE_CHANGED", "模板文字图层已变化，请重新读取模板"); }
        app.beginUndoGroup("LWS 合成复制");
        try { var folder = null, count = Math.ceil(sourceTexts.length / slots.length), created = [], placedLayers = [], allCopies = []; for (var batch = 0; batch < count; batch += 1) { var names = {}, graphCopies = [], duplicate = cloneGraph(template, {}, names, graphCopies), lengths = {}, batchWarnings = warningData(names), ok = true; for (i = 0; i < slots.length; i += 1) { var at = batch * slots.length + i; if (at >= sourceTexts.length) break; lengths[slots[i].path.join(".")] = slots[i].text === null ? 0 : String(slots[i].text).length; if (!writeText(layerAtPath(duplicate, slots[i].path), sourceTexts[at], batchWarnings)) ok = false; } if (!ok) { removeCopies(graphCopies); continue; } adaptGraph(duplicate, batchWarnings, lengths, []); var placed; try { placed = target.layers.add(duplicate); } catch (placeError) { removeCopies(graphCopies); throw placeError; } try { if (!folder) folder = outputFolder(); duplicate.parentFolder = folder; } catch (folderError) { try { if (placed) placed.remove(); } catch (ignorePlaced) {} removeCopies(graphCopies); throw folderError; } for (i = 0; i < graphCopies.length; i += 1) allCopies.push(graphCopies[i]); placedLayers.push(placed); created.push({ compId: duplicate.id, layerId: placed.id || null, batchIndex: batch + 1, sourceStart: batch * slots.length, sourceCount: Math.min(slots.length, sourceTexts.length - batch * slots.length) }); for (i = 0; i < batchWarnings.messages.length; i += 1) warnings.push(batchWarnings.messages[i]); if (batchWarnings.propertyCount) warnings.push({ code: "W_COMP_COPY_PROPERTY_ADAPT_FAILED", count: batchWarnings.propertyCount }); }
            if (!created.length) return fail("AE_COMP_COPY_ALL_FAILED", "没有成功复制合成", {}, warnings); return { data: { created: created, count: created.length, sourceTextCount: sourceTexts.length, templateTextLayerCount: slots.length, effects: { expressionsRebound: batchWarnings && batchWarnings.expressionCount || 0, characterSelectorsAdapted: batchWarnings && batchWarnings.selectorCount || 0, otherPropertiesPreserved: true } }, warnings: warnings };
        } catch (error) { for (i = 0; i < placedLayers.length; i += 1) try { placedLayers[i].remove(); } catch (ignorePlaced) {} removeCopies(allCopies); return fail("AE_COMP_COPY_FAILED", "合成复制失败", { message: error.toString() }, warnings); } finally { app.endUndoGroup(); }
    });
}());
