if (!$._LWS) $._LWS = {};

$._LWS.routes = $._LWS.routes || {};
$._LWS.hostCode = (BridgeTalk.appName === "aftereffects") ? "AEFT" : ((BridgeTalk.appName === "premierepro") ? "PPRO" : "UNKNOWN");
$._LWS.apiVersion = "1.0";

$._LWS.versionInfo = function () {
    var match = /^(\d+)\.(\d+)/.exec(String(app.version || ""));
    var requiredMajor = $._LWS.hostCode === "PPRO" ? 14 : 17;
    return {
        raw: String(app.version || ""),
        major: match ? Number(match[1]) : null,
        minor: match ? Number(match[2]) : null,
        requiredMajor: requiredMajor,
        supported: !!(match && Number(match[1]) >= requiredMajor)
    };
};

$._LWS.register = function (route, handler) {
    $._LWS.routes[route] = handler;
};

$._LWS.errorObject = function (code, message, details, recoverable) {
    return { code: code, message: message, recoverable: recoverable !== false, details: details || {} };
};

$._LWS.envelope = function (requestId, ok, data, warnings, error, startedAt) {
    return {
        apiVersion: $._LWS.apiVersion,
        requestId: requestId || "",
        ok: ok,
        data: ok ? data : null,
        warnings: warnings || [],
        error: ok ? null : error,
        meta: {
            host: $._LWS.hostCode,
            hostVersion: String(app.version || ""),
            elapsedMs: startedAt ? ((new Date()).getTime() - startedAt) : null
        }
    };
};

$._LWS.dispatch = function (route, encodedRequest) {
    var startedAt = (new Date()).getTime();
    var request = { requestId: "", params: {} };
    try {
        request = JSON.parse(decodeURIComponent(encodedRequest || "%7B%7D"));
    } catch (parseError) {
        return JSON.stringify($._LWS.envelope("", false, null, [], $._LWS.errorObject("INVALID_JSON", "请求 JSON 无效", { reason: parseError.toString() }), startedAt));
    }
    if (!request || typeof request !== "object" || request instanceof Array) return JSON.stringify($._LWS.envelope("", false, null, [], $._LWS.errorObject("INVALID_REQUEST", "请求必须是 JSON 对象"), startedAt));
    if (request.params !== undefined && (request.params === null || typeof request.params !== "object" || request.params instanceof Array)) return JSON.stringify($._LWS.envelope(request.requestId, false, null, [], $._LWS.errorObject("INVALID_REQUEST", "params 必须是 JSON 对象"), startedAt));
    if (request.apiVersion && request.apiVersion !== $._LWS.apiVersion) return JSON.stringify($._LWS.envelope(request.requestId, false, null, [], $._LWS.errorObject("API_VERSION_UNSUPPORTED", "宿主 API 版本不兼容", { requested: request.apiVersion, supported: $._LWS.apiVersion }), startedAt));
    if (!Object.prototype.hasOwnProperty.call($._LWS.routes, route) || typeof $._LWS.routes[route] !== "function") return JSON.stringify($._LWS.envelope(request.requestId, false, null, [], $._LWS.errorObject("UNKNOWN_METHOD", "未知宿主方法", { route: route }), startedAt));
    if (route !== "common.ping" && route !== "common.capabilities" && !$._LWS.versionInfo().supported) {
        var versionInfo = $._LWS.versionInfo();
        var productName = $._LWS.hostCode === "PPRO" ? "Premiere Pro" : "After Effects";
        return JSON.stringify($._LWS.envelope(request.requestId, false, null, [], $._LWS.errorObject("VERSION_UNSUPPORTED", "当前插件需要 " + productName + " 2020 或更高版本", { actual: String(app.version || ""), required: String(versionInfo.requiredMajor) + ".x+" }, false), startedAt));
    }
    try {
        var result = $._LWS.routes[route](request.params || {}, request) || {};
        if (result && result.ok === false && result.error) return JSON.stringify($._LWS.envelope(request.requestId, false, null, result.warnings || [], result.error, startedAt));
        return JSON.stringify($._LWS.envelope(request.requestId, true, result.data !== undefined ? result.data : result, result.warnings || [], null, startedAt));
    } catch (error) {
        return JSON.stringify($._LWS.envelope(request.requestId, false, null, [], $._LWS.errorObject(error.code || "HOST_EXCEPTION", error.message || error.toString(), { line: error.line || null, fileName: error.fileName || null }), startedAt));
    }
};

$._LWS.readJsonFile = function (pathValue) {
    var file = new File(pathValue);
    if (!file.exists) throw new Error("JSON file not found: " + pathValue);
    file.encoding = "UTF-8";
    if (!file.open("r")) throw new Error("Cannot open JSON file: " + pathValue);
    var text;
    try { text = file.read(); }
    finally { try { file.close(); } catch (ignoreClose) {} }
    if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    return JSON.parse(text);
};

$._LWS.writeJsonFile = function (pathValue, value) {
    var file = new File(pathValue);
    file.encoding = "UTF-8";
    if (!file.open("w")) throw new Error("Cannot write JSON file: " + pathValue);
    try { file.write(JSON.stringify(value)); }
    finally { try { file.close(); } catch (ignoreClose) {} }
    return file.fsName;
};

$._LWS.register("common.ping", function () {
    return { data: { host: $._LWS.hostCode, version: String(app.version || ""), appName: String(app.name || ""), apiVersion: $._LWS.apiVersion, supported: $._LWS.versionInfo().supported } };
});
