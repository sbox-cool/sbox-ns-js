import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOTNET_ESCAPED_RANGES } from "../src/util/dotnet-escape-ranges.js";
import { dotnetJsonString, stableJson } from "../src/util/json.js";
// Compiled tests run from dist-test/test; fixtures stay in the package source tree at test/fixtures.
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const fixture = JSON.parse(readFileSync(join(fixtureRoot, "dotnet-json-escape", "ranges.json"), "utf8"));
test("generated table matches the committed .NET 10 range fixture", () => {
    const flat = fixture.escapedBmpRanges.flat();
    assert.deepEqual([...DOTNET_ESCAPED_RANGES], flat);
});
test("every non-surrogate BMP unit is escaped exactly when the .NET fixture says so", () => {
    const escaped = new Set();
    for (const [start, end] of fixture.escapedBmpRanges) {
        for (let unit = start; unit <= end; unit++)
            escaped.add(unit);
    }
    for (let unit = 0x20; unit <= 0xffff; unit++) {
        if (unit >= 0xd800 && unit <= 0xdfff)
            continue;
        if (unit === 0x22 || unit === 0x5c)
            continue;
        const out = dotnetJsonString(String.fromCharCode(unit)).slice(1, -1);
        const isEscape = out.startsWith("\\u");
        assert.equal(isEscape, escaped.has(unit), `unit U+${unit.toString(16).padStart(4, "0")}`);
    }
});
test("quotes, backslash and short control escapes", () => {
    assert.equal(dotnetJsonString('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(dotnetJsonString("\b\f\n\r\t"), '"\\b\\f\\n\\r\\t"');
    assert.equal(dotnetJsonString("\u0001\u000b"), '"\\u0001\\u000B"');
});
test("unassigned, format, separator and private-use characters are escaped as the server does", () => {
    assert.equal(dotnetJsonString("\u0080"), '"\\u0080"');
    assert.equal(dotnetJsonString("\u00a0"), '"\\u00A0"');
    assert.equal(dotnetJsonString("\u2028"), '"\\u2028"');
    assert.equal(dotnetJsonString("\u3000"), '"\\u3000"');
    assert.equal(dotnetJsonString("\ufeff"), '"\\uFEFF"');
    assert.equal(dotnetJsonString("\ue000"), '"\\uE000"');
});
test("characters the server writes raw stay raw", () => {
    assert.equal(dotnetJsonString(" "), '" "');
    assert.equal(dotnetJsonString("é"), '"é"');
    assert.equal(dotnetJsonString("中"), '"中"');
    assert.equal(dotnetJsonString("\u00ad"), '"\u00ad"');
    assert.equal(dotnetJsonString("\u200b"), '"\u200b"');
    assert.equal(dotnetJsonString("\ufffd"), '"\ufffd"');
});
test("supplementary characters become escaped surrogate pairs, lone surrogates become U+FFFD", () => {
    assert.equal(dotnetJsonString("\u{1f600}"), '"\\uD83D\\uDE00"');
    assert.equal(dotnetJsonString("a\u{10000}b"), '"a\\uD800\\uDC00b"');
    assert.equal(dotnetJsonString("\ud800"), '"\\uFFFD"');
    assert.equal(dotnetJsonString("\udc00x"), '"\\uFFFDx"');
});
test("stableJson sorts keys by code unit and drops undefined, using the same string encoding", () => {
    assert.equal(stableJson({ b: 1, a: "x\u3000", c: undefined, B: [null, "é"] }), '{"B":[null,"é"],"a":"x\\u3000","b":1}');
});
