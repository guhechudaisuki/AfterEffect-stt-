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

    function msToTicks(ms) {
        var value = Math.max(0, Math.round(Number(ms)));
        var multiplier = "254016000";
        var carry = 0;
        var output = "";
        var i;
        var j;
        var digits = [];
        for (i = 0; i < String(value).length + multiplier.length; i += 1) digits[i] = 0;
        var a = String(value);
        for (i = a.length - 1; i >= 0; i -= 1) {
            for (j = multiplier.length - 1; j >= 0; j -= 1) {
                digits[(a.length - 1 - i) + (multiplier.length - 1 - j)] += Number(a.charAt(i)) * Number(multiplier.charAt(j));
            }
        }
        for (i = 0; i < digits.length; i += 1) {
            var total = digits[i] + carry;
            digits[i] = total % 10;
            carry = Math.floor(total / 10);
        }
        while (carry > 0) { digits.push(carry % 10); carry = Math.floor(carry / 10); }
        while (digits.length > 1 && digits[digits.length - 1] === 0) digits.pop();
        for (i = digits.length - 1; i >= 0; i -= 1) output += String(digits[i]);
        return output;
    }

    function readSegments(params) {
        var payload = params.segmentsFile ? $._LWS.readJsonFile(params.segmentsFile) : { segments: params.segments || [] };
        return payload.segments || [];
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

    function setMogrtParam(component, names, value, warnings, required) {
        var properties = component.properties;
        var prop = null;
        for (var i = 0; i < names.length && !prop; i += 1) {
            try { prop = properties.getParamForDisplayName(names[i]); } catch (ignore) {}
        }
        if (!prop) {
            if (required) throw new Error("Missing MOGRT parameter: " + names[0]);
            warnings.push({ code: "PR_MOGRT_PARAM_NOT_FOUND", name: names[0] });
            return false;
        }
        try { prop.setValue(value, true); return true; }
        catch (error) { if (required) throw error; warnings.push({ code: "PR_MOGRT_PARAM_SET_FAILED", name: names[0], message: error.toString() }); return false; }
    }

    $._LWS.register("common.capabilities", function () {
        var seq = sequence();
        var supported = $._LWS.versionInfo().supported;
        return { data: { host: "PPRO", version: String(app.version), supported: supported, features: { audioExport: !!(supported && app.encoder && app.encoder.encodeSequence), graphics: !!(supported && seq && seq.importMGT), nativeCaptions: !!(supported && seq && seq.createCaptionTrack), aeTemplates: false, moduleCopy: false }, ticksPerSecond: TICKS_PER_SECOND } };
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

    $._LWS.register("pr.tracks.list", function () {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        var tracks = [];
        for (var i = 0; i < seq.videoTracks.numTracks; i += 1) {
            var track = seq.videoTracks[i];
            tracks.push({ index: i, displayName: "V" + (i + 1), clipCount: track.clips.numItems, muted: track.isMuted ? track.isMuted() : false });
        }
        return { data: { tracks: tracks } };
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

    $._LWS.register("pr.subtitles.graphics.create", function (params) {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        if (!params.mogrtPath) return fail("INVALID_REQUEST", "MOGRT 路径不能为空");
        var mogrt = new File(params.mogrtPath);
        if (!mogrt.exists) return fail("PR_MOGRT_MISSING", "MOGRT 模板不存在", { path: params.mogrtPath });
        var trackIndex = Number(params.videoTrackIndex || 0);
        if (!isFinite(trackIndex) || trackIndex < 0 || Math.floor(trackIndex) !== trackIndex) return fail("INVALID_REQUEST", "视频轨道索引无效", { index: params.videoTrackIndex });
        if (trackIndex >= seq.videoTracks.numTracks) return fail("PR_TRACK_OUT_OF_RANGE", "目标视频轨道不存在", { index: trackIndex });
        var segments = readSegments(params);
        var created = [];
        var warnings = [];
        for (var i = 0; i < segments.length; i += 1) {
            var segment = segments[i];
            var clip = null;
            try {
                if (!(Number(segment.endMs) > Number(segment.startMs))) throw new Error("Invalid segment time");
                clip = seq.importMGT(mogrt.fsName, msToTicks(segment.startMs), trackIndex, 0);
                if (!clip) throw new Error("importMGT returned no TrackItem");
                var component = clip.getMGTComponent();
                if (!component) throw new Error("MGT component unavailable");
                setMogrtParam(component, ["LWS_TEXT"], segmentText(segment, params), warnings, true);
                var style = params.style || {};
                if (style.fontPostScriptName) setMogrtParam(component, ["LWS_FONT"], style.fontPostScriptName, warnings, false);
                if (style.fontSize !== undefined) setMogrtParam(component, ["LWS_FONT_SIZE"], Number(style.fontSize), warnings, false);
                if (style.tracking !== undefined) setMogrtParam(component, ["LWS_TRACKING"], Number(style.tracking), warnings, false);
                if (style.leading !== undefined) setMogrtParam(component, ["LWS_LEADING"], Number(style.leading), warnings, false);
                if (style.center) {
                    setMogrtParam(component, ["LWS_POSITION_X"], Number(style.center.x), warnings, false);
                    setMogrtParam(component, ["LWS_POSITION_Y"], Number(style.center.y), warnings, false);
                }
                var endTime = new Time();
                endTime.seconds = Number(segment.endMs) / 1000;
                clip.end = endTime;
                created.push({ segmentId: segment.id, nodeId: String(clip.nodeId), startMs: segment.startMs, endMs: segment.endMs });
            } catch (error) {
                try { if (clip) clip.remove(); } catch (ignorePartialClipRemove) {}
                warnings.push({ code: "PR_MOGRT_IMPORT_FAILED", segmentId: segment.id, message: error.toString() });
            }
        }
        if (!created.length && segments.length) return fail("PR_MOGRT_IMPORT_FAILED", "没有成功创建图形字幕", {}, warnings);
        return { data: { created: created, count: created.length }, warnings: warnings };
    });

    $._LWS.register("pr.subtitles.captions.create", function (params) {
        var seq = sequence();
        if (!seq) return fail("PR_NO_ACTIVE_SEQUENCE", "没有活动序列");
        if (!seq.createCaptionTrack) return fail("PR_CAPTION_API_UNAVAILABLE", "当前 PR 不支持公开 Caption Track 创建 API");
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
            var startAtTime = Number(params.startSeconds || 0);
            var result;
            if (params.captionFormat !== undefined && params.captionFormat !== null) result = seq.createCaptionTrack(projectItem, startAtTime, Number(params.captionFormat));
            else result = seq.createCaptionTrack(projectItem, startAtTime);
            if (!result) throw new Error("createCaptionTrack returned false");
            return { data: { created: true, projectItemNodeId: String(projectItem.nodeId) } };
        } catch (error) { return fail("PR_CAPTION_TRACK_FAILED", "原生字幕轨创建失败", { message: error.toString() }); }
    });
}());
