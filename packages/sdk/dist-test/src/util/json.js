import { DOTNET_ESCAPED_RANGES } from "./dotnet-escape-ranges.js";
const SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
};
function unicodeEscape(unit) {
    return "\\u" + unit.toString(16).toUpperCase().padStart(4, "0");
}
function isEscapedBmpUnit(unit) {
    let low = 0;
    let high = DOTNET_ESCAPED_RANGES.length / 2 - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const start = DOTNET_ESCAPED_RANGES[mid * 2];
        const end = DOTNET_ESCAPED_RANGES[mid * 2 + 1];
        if (unit < start)
            high = mid - 1;
        else if (unit > end)
            low = mid + 1;
        else
            return true;
    }
    return false;
}
/**
 * Encodes a string exactly as the server's .NET JSON writer does (UnsafeRelaxedJsonEscaping on .NET 10).
 * Lone surrogates become U+FFFD, supplementary characters are written as escaped UTF-16 pairs, and the
 * BMP escape set comes from the generated table in dotnet-escape-ranges.ts.
 */
export function dotnetJsonString(value) {
    let out = '"';
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        const unit = value.charCodeAt(index);
        const short = SHORT_ESCAPES[char];
        if (short !== undefined) {
            out += short;
        }
        else if (unit < 0x20) {
            out += unicodeEscape(unit);
        }
        else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                out += unicodeEscape(unit) + unicodeEscape(next);
                index++;
            }
            else {
                out += "\\uFFFD";
            }
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff) {
            out += "\\uFFFD";
        }
        else if (isEscapedBmpUnit(unit)) {
            out += unicodeEscape(unit);
        }
        else {
            out += char;
        }
    }
    return out + '"';
}
/**
 * Serializes a value with object keys in ordinal (code unit) order at every depth. The server builds
 * every AAD, signature binding and config digest from this form, so the output must match byte for byte.
 */
export function stableJson(value) {
    if (value === null)
        return "null";
    if (typeof value === "string")
        return dotnetJsonString(value);
    if (typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return "[" + value.map((item) => (item === undefined ? "null" : stableJson(item))).join(",") + "]";
    }
    const record = value;
    const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => dotnetJsonString(key) + ":" + stableJson(record[key]));
    return "{" + entries.join(",") + "}";
}
