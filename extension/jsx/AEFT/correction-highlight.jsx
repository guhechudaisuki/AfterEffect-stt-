/* Correction colors are applied after the template is copied. ES3 only. */
(function () {
    function findProperty(group, matchName) {
        if (!group) return null;
        var direct = null;
        try { direct = group.property(matchName); } catch (ignoreDirect) {}
        if (direct) return direct;
        try { for (var i = 1; i <= group.numProperties; i += 1) { var child = group.property(i); if (child.matchName === matchName) return child; if (child.numProperties) { var found = findProperty(child, matchName); if (found) return found; } } } catch (ignoreChildren) {}
        return null;
    }
    function rgb(value) {
        var hex = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).substring(1) : "0000ff";
        return [parseInt(hex.substr(0, 2), 16) / 255, parseInt(hex.substr(2, 2), 16) / 255, parseInt(hex.substr(4, 2), 16) / 255];
    }
    function hold(prop) { try { for (var k = 1; k <= prop.numKeys; k += 1) prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (ignoreHold) {} }
    $._LWS.applyCorrectionHighlights = function (layer, segments, singleLayer, warnings) {
        var text = layer.property("ADBE Text Properties"), animators = text && text.property("ADBE Text Animators");
        if (!animators) return;
        var added = 0;
        for (var i = 0; i < segments.length; i += 1) {
            var segment = segments[i], rendered = segment.rendered;
            if (!rendered || !rendered.ranges || !rendered.ranges.length) continue;
            for (var r = 0; r < rendered.ranges.length; r += 1) {
                var range = rendered.ranges[r], animatorIndex = 0;
                if (!(range.end > range.start) || range.start < 0 || range.end > rendered.text.length) continue;
                try {
                    var animator = animators.addProperty("ADBE Text Animator");
                    animatorIndex = animators.numProperties;
                    animator.name = "LWS 纠错标色 " + (i + 1) + "." + (r + 1);
                    animator.property("ADBE Text Animator Properties").addProperty("ADBE Text Fill Color").setValue(rgb(rendered.color));
                    // Adding an indexed property may invalidate prior handles.
                    animator = animators.property(animatorIndex);
                    var selector = animator.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
                    var units = findProperty(selector, "ADBE Text Range Units");
                    if (!units) throw new Error("Text range units unavailable");
                    units.setValue(2);
                    selector = animators.property(animatorIndex).property("ADBE Text Selectors").property(1);
                    var basedOn = findProperty(selector, "ADBE Text Range Type2");
                    if (basedOn) basedOn.setValue(1);
                    var smoothness = findProperty(selector, "ADBE Text Selector Smoothness");
                    if (smoothness) smoothness.setValue(0);
                    var start = findProperty(selector, "ADBE Text Index Start"), end = findProperty(selector, "ADBE Text Index End");
                    if (!start || !end) throw new Error("Text index selector unavailable");
                    // AE character selectors exclude paragraph separators.
                    var prefix = String(rendered.text).substring(0, range.start).replace(/[\r\n]/g, "").length;
                    var length = String(rendered.text).substring(range.start, range.end).replace(/[\r\n]/g, "").length;
                    start.setValue(prefix); end.setValue(prefix + length);
                    if (singleLayer) {
                        var amount = findProperty(selector, "ADBE Text Selector Max Amount");
                        if (!amount) throw new Error("Text selector amount unavailable");
                        var startTime = Number(segment.startMs) / 1000, endTime = Number(segment.endMs) / 1000;
                        if (layer.inPoint < startTime) amount.setValueAtTime(layer.inPoint, 0);
                        amount.setValueAtTime(startTime, 100);
                        amount.setValueAtTime(endTime, 0);
                        hold(amount);
                    }
                    added += 1;
                } catch (error) {
                    try { if (animatorIndex) animators.property(animatorIndex).remove(); } catch (ignoreRemove) {}
                    warnings.push({ code: "AE_CORRECTION_HIGHLIGHT_FAILED", segmentId: segment.id, message: error.toString() });
                }
            }
        }
        return added;
    };
}());
