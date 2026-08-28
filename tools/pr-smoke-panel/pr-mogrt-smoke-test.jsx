#target premierepro

(function () {
    var report = { host: String(app.version || ""), checks: [], ok: false };
    var output = new File(Folder.temp.fsName + "/LocalWhisper-pr-smoke.json");
    var sequence = app.project && app.project.activeSequence;
    var clip = null;

    function addCheck(name, passed, details) {
        report.checks.push({ name: name, passed: !!passed, details: details || {} });
    }

    function writeReport() {
        output.encoding = "UTF-8";
        if (!output.open("w")) return;
        try { output.write(JSON.stringify(report)); }
        finally { output.close(); }
    }

    try {
        var versionMatch = /^(\d+)\.(\d+)/.exec(report.host);
        addCheck("host-version-2022-plus", !!(versionMatch && Number(versionMatch[1]) >= 22), { version: report.host });
        if (!sequence) throw new Error("Open an active Premiere Pro sequence before running the smoke test");
        addCheck("public-importMGT", !!sequence.importMGT);
        addCheck("public-caption-api", !!sequence.createCaptionTrack);
        if (!sequence.importMGT) throw new Error("Sequence.importMGT is unavailable");

        var mogrt = File.openDialog("Choose LocalWhisper_Default_25_6.mogrt", "*.mogrt");
        if (!mogrt) throw new Error("No MOGRT selected");
        var start = sequence.getInPointAsTime ? sequence.getInPointAsTime() : null;
        var startTicks = start ? String(start.ticks) : "0";
        clip = sequence.importMGT(mogrt.fsName, startTicks, 0, 0);
        if (!clip) throw new Error("Sequence.importMGT returned no TrackItem");
        var component = clip.getMGTComponent();
        if (!component) throw new Error("TrackItem.getMGTComponent returned no component");
        var textParam = component.properties.getParamForDisplayName("LWS_TEXT");
        if (!textParam) throw new Error("MOGRT is missing the LWS_TEXT exposed parameter");
        textParam.setValue("Local Whisper smoke", true);
        addCheck("mogrt-text-controller", true, { parameter: "LWS_TEXT", nodeId: String(clip.nodeId) });
        report.ok = true;
    } catch (error) {
        report.error = { message: error.toString(), line: error.line || null };
    } finally {
        try { if (clip) clip.remove(); } catch (ignoreRemove) {}
        writeReport();
    }
    alert("Local Whisper PR MOGRT smoke: " + (report.ok ? "PASS" : "FAIL") + "\n" + output.fsName);
}());
