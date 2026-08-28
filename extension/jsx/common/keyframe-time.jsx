if (!$._LWS) $._LWS = {};

$._LWS.mapKeyTime = function (sourceTime, sourceIn, sourceOut, targetIn, targetOut) {
    var sourceDuration = Number(sourceOut) - Number(sourceIn);
    var targetDuration = Number(targetOut) - Number(targetIn);
    var normalized;
    var error;
    if (!(sourceDuration > 0) || !(targetDuration > 0)) {
        error = new Error("Layer effective duration is zero");
        error.code = "AE_INVALID_LAYER_DURATION";
        throw error;
    }
    normalized = (Number(sourceTime) - Number(sourceIn)) / sourceDuration;
    normalized = Math.max(0, Math.min(1, normalized));
    return Number(targetIn) + normalized * targetDuration;
};

$._LWS.scaleTemporalSpeed = function (sourceSpeed, sourceIn, sourceOut, targetIn, targetOut) {
    var sourceDuration = Number(sourceOut) - Number(sourceIn);
    var targetDuration = Number(targetOut) - Number(targetIn);
    var error;
    if (!(sourceDuration > 0) || !(targetDuration > 0)) {
        error = new Error("Layer effective duration is zero");
        error.code = "AE_INVALID_LAYER_DURATION";
        throw error;
    }
    return Number(sourceSpeed) * sourceDuration / targetDuration;
};
