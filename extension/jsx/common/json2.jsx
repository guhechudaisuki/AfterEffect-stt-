if (typeof JSON === "undefined") {
    JSON = {};
}

if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (value) {
        function quote(text) {
            var escapes = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
            return '"' + String(text).replace(/[\\"\u0000-\u001f]/g, function (character) {
                var code;
                var hex;
                if (escapes[character]) return escapes[character];
                code = character.charCodeAt(0);
                hex = code.toString(16);
                return "\\u" + ("0000" + hex).substring(hex.length);
            }) + '"';
        }
        function encode(item) {
            var i;
            var parts;
            if (item === null) return "null";
            if (typeof item === "string") return quote(item);
            if (typeof item === "number") return isFinite(item) ? String(item) : "null";
            if (typeof item === "boolean") return String(item);
            if (item instanceof Array) {
                parts = [];
                for (i = 0; i < item.length; i += 1) parts.push(encode(item[i]));
                return "[" + parts.join(",") + "]";
            }
            if (typeof item === "object") {
                parts = [];
                for (i in item) {
                    if (Object.prototype.hasOwnProperty.call(item, i) && typeof item[i] !== "undefined" && typeof item[i] !== "function") parts.push(quote(i) + ":" + encode(item[i]));
                }
                return "{" + parts.join(",") + "}";
            }
            return "null";
        }
        return encode(value);
    };
}

if (typeof JSON.parse !== "function") {
    JSON.parse = function (text) {
        if (!/^[\],:{}\s]*$/.test(String(text).replace(/\\["\\\/bfnrtu]/g, "@").replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]").replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) throw new Error("Invalid JSON");
        return eval("(" + text + ")");
    };
}
