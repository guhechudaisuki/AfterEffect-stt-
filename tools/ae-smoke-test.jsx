#target aftereffects

(function () {
    var report = { host: String(app.version || ""), checks: [], ok: false };
    var comp = null;
    var output = new File(Folder.temp.fsName + "/LocalWhisper-ae-smoke.json");
    function closeEnough(actual, expected) { return Math.abs(actual - expected) < 0.0001; }
    try {
        if (!app.project) throw new Error("Open or create an AE project before running the smoke test");
        comp = app.project.items.addComp("__LWS_AE_SMOKE__", 1920, 1080, 1, 30, 25);
        var source = comp.layers.addText("Template");
        source.startTime = 0;
        source.inPoint = 0;
        source.outPoint = 2;
        var effect = source.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
        var slider = effect.property(1);
        slider.setValueAtTime(0, 0);
        slider.setValueAtTime(0.5, 25);
        slider.setValueAtTime(1, 50);
        slider.setValueAtTime(2, 100);

        var copy = source.duplicate();
        var ratio = 5 / 2;
        copy.stretch = source.stretch * ratio;
        copy.startTime = 10 - (source.inPoint - source.startTime) * ratio;
        copy.inPoint = 10;
        copy.outPoint = 15;
        var copiedSlider = copy.property("ADBE Effect Parade").property(1).property(1);
        var expected = [10, 11.25, 12.5, 15];
        var actual = [];
        var passed = copiedSlider.numKeys === expected.length;
        for (var i = 1; i <= copiedSlider.numKeys; i += 1) {
            actual.push(copiedSlider.keyTime(i));
            if (!closeEnough(actual[i - 1], expected[i - 1])) passed = false;
        }
        report.checks.push({ name: "layer-stretch-normalizes-template-keys", passed: passed, expected: expected, actual: actual });
        report.ok = passed;
    } catch (error) {
        report.error = { message: error.toString(), line: error.line || null };
    } finally {
        try { if (comp) comp.remove(); } catch (ignoreRemove) {}
        output.encoding = "UTF-8";
        if (output.open("w")) {
            output.write(JSON.stringify(report));
            output.close();
        }
    }
    alert("Local Whisper AE smoke: " + (report.ok ? "PASS" : "FAIL") + "\n" + output.fsName);
}());
