/*
 * CEP host bootstrap.
 *
 * ExtendScript reports every top-level exception to CEP as the same
 * "EvalScript error." string.  Keep the bootstrap non-throwing so that a
 * missing or malformed dependency can be reported through a normal JSON
 * envelope instead of leaving $._LWS undefined.
 */
(function () {
    var status = {
        ok: false,
        host: "UNKNOWN",
        root: "",
        attempted: [],
        loaded: [],
        errors: []
    };

    function asText(value) {
        try { return String(value && value.message ? value.message : value); }
        catch (ignore) { return "Unknown ExtendScript error"; }
    }

    function safeStringify(value) {
        var i;
        var key;
        var parts;
        var text;
        if (typeof JSON !== "undefined" && JSON && typeof JSON.stringify === "function" && JSON.stringify !== safeStringify) {
            try { return JSON.stringify(value); } catch (ignoreJson) {}
        }
        if (value === null || value === undefined) return "null";
        if (typeof value === "string") return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        if (value instanceof Array) {
            parts = [];
            for (i = 0; i < value.length; i += 1) parts.push(safeStringify(value[i]));
            return "[" + parts.join(",") + "]";
        }
        parts = [];
        for (key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== "function" && value[key] !== undefined) {
                text = String(key).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                parts.push('"' + text + '":' + safeStringify(value[key]));
            }
        }
        return "{" + parts.join(",") + "}";
    }

    function ensureJsonFallback() {
        if (typeof JSON === "undefined" || !JSON) JSON = {};
        if (typeof JSON.stringify !== "function") JSON.stringify = safeStringify;
        if (typeof JSON.parse !== "function") JSON.parse = function (text) { return eval("(" + text + ")"); };
    }

    function hostName() {
        try {
            if (typeof BridgeTalk !== "undefined" && BridgeTalk && BridgeTalk.appName) {
                if (BridgeTalk.appName === "aftereffects") return "AEFT";
                if (BridgeTalk.appName === "premierepro") return "PPRO";
            }
        } catch (ignoreBridgeTalk) {}
        return "UNKNOWN";
    }

    function ensureNamespace() {
        if (!$._LWS) $._LWS = {};
        if (!$._LWS.routes) $._LWS.routes = {};
        $._LWS.bootstrapStatus = status;
    }

    function errorEnvelope(code, message, details) {
        return safeStringify({
            apiVersion: "1.0",
            requestId: "",
            ok: false,
            data: null,
            warnings: [],
            error: { code: code, message: message, recoverable: true, details: details || {} },
            meta: { host: status.host, hostVersion: "", elapsedMs: null }
        });
    }

    function installFallbackDispatch() {
        if (typeof $._LWS.dispatch === "function") return;
        $._LWS.dispatch = function (route) {
            if (route === "common.bootstrapStatus") {
                return safeStringify({
                    apiVersion: "1.0",
                    requestId: "",
                    ok: false,
                    data: null,
                    warnings: [],
                    error: {
                        code: "HOST_BOOTSTRAP_FAILED",
                        message: "Adobe host bootstrap incomplete",
                        recoverable: true,
                        details: status
                    },
                    meta: { host: status.host, hostVersion: "", elapsedMs: null }
                });
            }
            return errorEnvelope("HOST_BOOTSTRAP_FAILED", "Adobe host bootstrap incomplete", status);
        };
    }

    function registerBootstrapRoute() {
        if (typeof $._LWS.register !== "function") return;
        $._LWS.register("common.bootstrapStatus", function () {
            return {
                ok: status.ok,
                data: status,
                error: status.ok ? null : { code: "HOST_BOOTSTRAP_FAILED", message: "Adobe host bootstrap incomplete", recoverable: true, details: status }
            };
        });
    }

    function addCandidate(list, value) {
        var normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
        var i;
        if (!normalized) return;
        for (i = 0; i < list.length; i += 1) if (list[i] === normalized) return;
        list.push(normalized);
    }

    function normalizeRoot(value) {
        var normalized = String(value || "");
        try { normalized = decodeURIComponent(normalized); } catch (ignoreDecode) {}
        normalized = normalized.replace(/^file:\/{2,3}/i, "");
        if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.substring(1);
        normalized = normalized.replace(/\\/g, "/").replace(/\/+$/g, "");
        if (/\/jsx$/i.test(normalized)) return normalized;
        if (/\/host\.jsx$/i.test(normalized)) return normalized.substring(0, normalized.length - 9);
        return normalized;
    }

    function resolveRoot() {
        var candidates = [];
        var file;
        try {
            if ($.fileName) {
                file = new File($.fileName);
                addCandidate(candidates, file.parent && file.parent.fsName);
                addCandidate(candidates, file.path);
            }
        } catch (fileError) {
            status.errors.push({ stage: "resolveRoot", error: asText(fileError) });
        }
        try { if (Folder.current) addCandidate(candidates, Folder.current.fsName); }
        catch (folderError) { status.errors.push({ stage: "resolveRoot", error: asText(folderError) }); }
        if (candidates.length) {
            var i;
            for (i = 0; i < candidates.length; i += 1) {
                try {
                    if (new File(candidates[i] + "/common/json2.jsx").exists) return candidates[i];
                } catch (existsError) {}
            }
            return candidates[0];
        }
        return "";
    }

    function loadScript(relativePath) {
        var fullPath = status.root ? status.root + "/" + relativePath : relativePath;
        var file;
        var code;
        var firstError = "";
        status.attempted.push(relativePath + " at " + fullPath);
        try {
            file = new File(fullPath);
            if (!file.exists) {
                status.errors.push({ stage: relativePath, error: "File not found", path: fullPath });
                return false;
            }
            try {
                $.evalFile(file);
                status.loaded.push(relativePath);
                return true;
            } catch (evalError) {
                firstError = asText(evalError);
            }
            try {
                file.encoding = "UTF-8";
                if (!file.open("r")) throw new Error("Cannot open file");
                code = file.read();
                file.close();
                eval(code);
                status.loaded.push(relativePath);
                return true;
            } catch (fallbackError) {
                try { file.close(); } catch (ignoreClose) {}
                status.errors.push({ stage: relativePath, error: asText(fallbackError), evalFileError: firstError, path: fullPath });
                return false;
            }
        } catch (fileError) {
            status.errors.push({ stage: relativePath, error: asText(fileError), evalFileError: firstError, path: fullPath });
            return false;
        }
    }

    function resetStatus() {
        status.ok = false;
        status.root = "";
        status.attempted = [];
        status.loaded = [];
        status.errors = [];
    }

    function finishBootstrap() {
        loadScript("common/json2.jsx");
        loadScript("common/response.jsx");
        loadScript("common/keyframe-time.jsx");
        if (status.host === "AEFT") {
            loadScript("AEFT/host.jsx");
            loadScript("AEFT/comp-copy.jsx");
        }
        else if (status.host === "PPRO") loadScript("PPRO/host.jsx");
        else status.errors.push({ stage: "hostAdapter", error: "Unsupported Adobe host" });
        status.ok = status.errors.length === 0 && typeof $._LWS.dispatch === "function";
        ensureNamespace();
        registerBootstrapRoute();
        installFallbackDispatch();
        return status.ok;
    }

    function bootstrapFromRoot(rootPayload) {
        var requested = normalizeRoot(rootPayload);
        var candidates = [];
        var i;
        resetStatus();
        status.host = hostName();
        addCandidate(candidates, requested);
        if (requested && !/\/jsx$/i.test(requested)) addCandidate(candidates, requested + "/jsx");
        if (requested && /\/jsx$/i.test(requested)) addCandidate(candidates, requested.substring(0, requested.length - 4));
        for (i = 0; i < candidates.length; i += 1) {
            try {
                if (new File(candidates[i] + "/common/json2.jsx").exists) {
                    status.root = candidates[i];
                    break;
                }
            } catch (existsError) {}
        }
        if (!status.root) {
            status.root = candidates.length ? candidates[0] : requested;
            status.errors.push({ stage: "resolveRoot", error: "File not found", path: status.root + "/common/json2.jsx" });
        } else {
            finishBootstrap();
        }
        ensureNamespace();
        registerBootstrapRoute();
        installFallbackDispatch();
        return safeStringify({ ok: status.ok, data: status, error: status.ok ? null : { code: "HOST_BOOTSTRAP_FAILED", message: "Adobe host bootstrap incomplete", recoverable: true, details: status } });
    }

    ensureNamespace();
    ensureJsonFallback();
    status.host = hostName();
    try { status.root = resolveRoot(); }
    catch (rootError) { status.errors.push({ stage: "resolveRoot", error: asText(rootError) }); }
    $._LWS.bootstrapFromRoot = bootstrapFromRoot;
    finishBootstrap();
}());
