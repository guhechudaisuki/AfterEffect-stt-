(function () {
    var TICKS_PER_SECOND = "254016000000";
    $._LWS.prEncoderJobs = $._LWS.prEncoderJobs || {};
    $._LWS.prEncoderBound = $._LWS.prEncoderBound || false;

    function fail(code, message, details, warnings) {
        return { ok: false, error: $._LWS.errorObject(code, message, details || {}), warnings: warnings || [] };
    }

    function sequence() {
        return app.project ? app.project.activeSequence : null;
    }

    function dispatch(type, data) {
        try {
            var library = new ExternalObject("lib:PlugPlugExternalObject.dll");
            if (library) {
                var event = new CSXSEvent();
                event.type = type;
                event.data = JSON.stringify(data);
                event.dispatch();
            }
        } catch (ignore) {}
    }

    $._LWS.onEncoderComplete = function (jobId, outputFilePath) {
        var info = $._LWS.prEncoderJobs[String(jobId)] || {};
        dispatch("com.localwhisper.subtitles.encoder", { type: "complete", jobId: String(jobId), outputPath: outputFilePath || info.outputPath });
        delete $._LWS.prEncoderJobs[String(jobId)];
    };

    $._LWS.onEncoderError = function (jobId, message) {
        dispatch("com.localwhisper.subtitles.encoder", { type: "error", jobId: String(jobId), message: String(message || "") });
        delete $._LWS.prEncoderJobs[String(jobId)];
    };

    $._LWS.onEncoderProgress = function (jobId, progress) {
        dispatch("com.localwhisper.subtitles.encoder", { type: "progress", jobId: String(jobId), progress: Number(progress) });
    };

    $._LWS.onEncoderQueued = function (jobId) {
        dispatch("com.localwhisper.subtitles.encoder", { type: "queued", jobId: String(jobId) });
        try { app.encoder.startBatch(); } catch (ignore) {}
    };

    $._LWS.onEncoderCanceled = function (jobId) {
        dispatch("com.localwhisper.subtitles.encoder", { type: "canceled", jobId: String(jobId) });
        delete $._LWS.prEncoderJobs[String(jobId)];
    };

    function bindEncoder() {
        if ($._LWS.prEncoderBound) return;
        app.encoder.bind("onEncoderJobComplete", $._LWS.onEncoderComplete);
        app.encoder.bind("onEncoderJobError", $._LWS.onEncoderError);
        app.encoder.bind("onEncoderJobProgress", $._LWS.onEncoderProgress);
        app.encoder.bind("onEncoderJobQueued", $._LWS.onEncoderQueued);
        app.encoder.bind("onEncoderJobCanceled", $._LWS.onEncoderCanceled);
        $._LWS.prEncoderBound = true;
    }

    function timeInfo(time) {
        if (!time) return null;
        return { seconds: Number(time.seconds), ticks: String(time.ticks) };
    }

    function timeFromSeconds(seconds) {
        var value = new Time();
        value.seconds = Number(seconds);
        return value;
    }

    function sequenceRange(seq) {
        var start;
        var end;
        if (seq.getInPointAsTime && seq.getOutPointAsTime) {
            start = seq.getInPointAsTime();
            end = seq.getOutPointAsTime();
        } else if (seq.getInPoint && seq.getOutPoint) {
            start = timeFromSeconds(seq.getInPoint());
            end = timeFromSeconds(seq.getOutPoint());
        }
        return { start: start, end: end };
    }

    $._LWS.register("common.capabilities", function () {
        var seq = sequence();
        var supported = $._LWS.versionInfo().supported;
        return { data: { host: "PPRO", version: String(app.version), supported: supported, features: { audioExport: !!(supported && app.encoder && app.encoder.encodeSequence), captionImport: !!(supported && seq && app.project && app.project.importFiles), nativeCaptions: !!(supported && seq && typeof seq.createCaptionTrack === "function"), aeTemplates: false, moduleCopy: false }, ticksPerSecond: TICKS_PER_SECOND } };
    });

    $._LWS.register("pr.context.get", function () {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        var settings = seq.getSettings();
        return { data: { projectPath: app.project.path || null, activeSequence: { sequenceId: String(seq.sequenceID), name: seq.name, frameSizeHorizontal: settings.videoFrameWidth, frameSizeVertical: settings.videoFrameHeight, end: timeInfo(seq.end), zeroPoint: String(seq.zeroPoint) } } };
    });

    $._LWS.register("pr.range.get", function () {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        var range = sequenceRange(seq);
        var start = range.start;
        var end = range.end;
        if (!start || !end || Number(end.seconds) <= Number(start.seconds)) return fail("PR_INVALID_RANGE", "序列入点到出点无效");
        return { data: { timeBase: "premiereTicks", start: timeInfo(start), end: timeInfo(end), durationSeconds: Number(end.seconds) - Number(start.seconds) } };
    });

    $._LWS.register("pr.audio.export", function (params) {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        if (!params.outputPath || !params.presetPath) return fail("INVALID_REQUEST", "音频输出路径和预设路径不能为空");
        var preset = new File(params.presetPath);
        if (!preset.exists) return fail("PR_PRESET_MISSING", "PR 音频预设不存在", { path: params.presetPath });
        var range = sequenceRange(seq);
        if (!range.start || !range.end || Number(range.end.seconds) <= Number(range.start.seconds)) return fail("PR_INVALID_RANGE", "序列入点到出点无效");
        try {
            bindEncoder();
            app.encoder.launchEncoder();
            app.encoder.setSidecarXMPEnabled(0);
            app.encoder.setEmbeddedXMPEnabled(0);
            var jobId = app.encoder.encodeSequence(seq, params.outputPath, preset.fsName, app.encoder.ENCODE_IN_TO_OUT, 1);
            if (!jobId) return fail("PR_ENCODER_QUEUE_FAILED", "无法提交音频导出任务");
            $._LWS.prEncoderJobs[String(jobId)] = { outputPath: params.outputPath, startedAt: (new Date()).getTime() };
            return { data: { status: "queued", jobId: String(jobId), outputPath: params.outputPath, rangeStart: timeInfo(range.start), rangeEnd: timeInfo(range.end) } };
        } catch (error) { return fail("PR_EXPORT_FAILED", "PR 音频导出失败", { message: error.toString() }); }
    });

    $._LWS.register("pr.subtitles.captions.create", function (params) {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        if (!params.srtPath) return fail("INVALID_REQUEST", "SRT 路径不能为空");
        var srt = new File(params.srtPath);
        if (!srt.exists) return fail("FILE_NOT_FOUND", "SRT 文件不存在", { path: params.srtPath });
        try {
            var bin = app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem;
            var before = {};
            var i;
            for (i = 0; i < bin.children.numItems; i += 1) before[String(bin.children[i].nodeId)] = true;
            var imported = app.project.importFiles([srt.fsName], true, bin, false);
            var projectItem = null;
            if (!imported) throw new Error("SRT import failed");
            for (i = 0; i < bin.children.numItems; i += 1) if (!before[String(bin.children[i].nodeId)]) { projectItem = bin.children[i]; break; }
            if (!projectItem) throw new Error("Imported SRT project item was not found");
            if (typeof seq.createCaptionTrack !== "function") {
                return {
                    data: { created: false, imported: true, requiresManualPlacement: true, projectItemNodeId: String(projectItem.nodeId), srtPath: srt.fsName },
                    warnings: [{ code: "PR_CAPTION_API_UNAVAILABLE", message: "当前 Premiere Pro 已导入 SRT，但此版本需要手动把字幕素材拖入时间轴。" }]
                };
            }
            var startAtTime = Number(params.startSeconds || 0);
            var result;
            if (params.captionFormat !== undefined && params.captionFormat !== null) result = seq.createCaptionTrack(projectItem, startAtTime, Number(params.captionFormat));
            else result = seq.createCaptionTrack(projectItem, startAtTime);
            if (!result) throw new Error("createCaptionTrack returned false");
            return { data: { created: true, imported: true, requiresManualPlacement: false, projectItemNodeId: String(projectItem.nodeId) } };
        } catch (error) { return fail("PR_CAPTION_TRACK_FAILED", "原生字幕轨创建失败", { message: error.toString() }); }
    });
}());
