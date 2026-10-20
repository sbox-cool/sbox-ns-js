import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { upgradeSource, type SourceTools, type UpgradeOutcome } from "../src/server/source-upgrade.js";
import { isRecord } from "../src/util/guards.js";

const tools: SourceTools = { parseYaml: parse, stringifyYaml: stringify };

const ENDPOINT_TEXT = [
  "sourceVersion: 1",
  "kind: endpoint",
  "id: mine-ore",
  "name: Mine Ore",
  "description: Adds ore.",
  "exposure: public",
  "method: POST",
  "steps: []",
  "response:",
  "  status: 200",
  "  body:",
  "    ok: true",
  "",
].join("\n");

function codesOf(outcome: UpgradeOutcome): unknown[] {
  const list = outcome.body["diagnostics"];
  assert.ok(Array.isArray(list));
  return list.map((item) => (isRecord(item) ? item["code"] : undefined));
}

test("a valid endpoint source is returned verbatim and is safe to write", () => {
  const outcome = upgradeSource({ kind: "endpoint", id: "mine-ore", sourceFormat: "yaml", sourceText: ENDPOINT_TEXT }, tools);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.body["ok"], true);
  assert.equal(outcome.body["resourceKind"], "endpoint");
  assert.equal(outcome.body["resourceId"], "mine-ore");
  assert.equal(outcome.body["sourcePath"], "mine-ore.endpoint.yml");
  assert.equal(outcome.body["upgradedSourceText"], ENDPOINT_TEXT);
  assert.deepEqual(outcome.body["diagnostics"], []);
  assert.equal(outcome.body["safeAutoWrite"], true);
});

test("CRLF and a BOM are normalised out of the upgraded source text", () => {
  const text = `\uFEFF${ENDPOINT_TEXT.replace(/\n/g, "\r\n")}`;
  const outcome = upgradeSource({ kind: "endpoint", id: "mine-ore", sourceText: text }, tools);
  assert.equal(outcome.body["upgradedSourceText"], ENDPOINT_TEXT);
});

test("a flat endpoint without sourceText is written as the authored DSL document", () => {
  const outcome = upgradeSource(
    {
      kind: "endpoint",
      id: "ping",
      method: "GET",
      exposure: "public",
      steps: [],
      response: { status: 200, body: { ok: true } },
    },
    tools,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.body["safeAutoWrite"], true);
  assert.deepEqual(parse(String(outcome.body["upgradedSourceText"])), {
    sourceVersion: 1,
    kind: "endpoint",
    id: "ping",
    method: "GET",
    exposure: "public",
    steps: [],
    response: { status: 200, body: { ok: true } },
  });
});

test("an invalid step list is reported as SOURCE_DEFINITION_INVALID and blocks the automatic write", () => {
  const text = ENDPOINT_TEXT.replace("steps: []", "steps: nope");
  const outcome = upgradeSource({ kind: "endpoint", id: "mine-ore", sourceText: text }, tools);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.body["safeAutoWrite"], false);
  assert.deepEqual(codesOf(outcome), ["SOURCE_DEFINITION_INVALID"]);
  const list = outcome.body["diagnostics"];
  assert.ok(Array.isArray(list));
  assert.ok(isRecord(list[0]));
  assert.equal(list[0]["severity"], "error");
});

test("an unrecognised top-level field is a warning and blocks the automatic write", () => {
  const outcome = upgradeSource({ kind: "endpoint", id: "mine-ore", sourceText: `${ENDPOINT_TEXT}mystery: 1\n` }, tools);
  assert.equal(outcome.body["safeAutoWrite"], false);
  assert.deepEqual(codesOf(outcome), ["SOURCE_UPGRADE_AMBIGUOUS_FIELD"]);
});

test("an unsupported kind fails the upgrade at /kind", () => {
  const outcome = upgradeSource({ kind: "sprite", id: "x" }, tools);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.body["error"], "SOURCE_UPGRADE_FAILED");
  assert.equal(outcome.body["safeAutoWrite"], false);
  const list = outcome.body["diagnostics"];
  assert.ok(Array.isArray(list));
  assert.ok(isRecord(list[0]));
  assert.equal(list[0]["code"], "SOURCE_COMPILE_FAILED");
  assert.equal(list[0]["sourcePath"], "/kind");
});

test("a source whose kind differs from the request fails the upgrade", () => {
  const outcome = upgradeSource({ kind: "endpoint", id: "mine-ore", sourceText: ENDPOINT_TEXT.replace("kind: endpoint", "kind: workflow") }, tools);
  assert.equal(outcome.ok, false);
  const list = outcome.body["diagnostics"];
  assert.ok(Array.isArray(list));
  assert.ok(isRecord(list[0]));
  assert.equal(list[0]["message"], "Source kind 'workflow' does not match 'endpoint'.");
});

test("writing YAML output without a stringifier is SOURCE_UPGRADE_UNAVAILABLE", () => {
  const outcome = upgradeSource({ kind: "endpoint", id: "ping", method: "GET", steps: [] }, { parseYaml: parse, stringifyYaml: undefined });
  assert.equal(outcome.ok, false);
  assert.deepEqual(codesOf(outcome), ["SOURCE_UPGRADE_UNAVAILABLE"]);
});

test("a test record without an endpoint is reported at /endpoint", () => {
  const outcome = upgradeSource({ kind: "test", id: "t1" }, tools);
  assert.equal(outcome.body["safeAutoWrite"], false);
  const list = outcome.body["diagnostics"];
  assert.ok(Array.isArray(list));
  assert.ok(isRecord(list[0]));
  assert.equal(list[0]["sourcePath"], "/endpoint");
});

test("a complete test record is safe to write", () => {
  const outcome = upgradeSource({ kind: "test", id: "t1", endpoint: "mine-ore" }, tools);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.body["safeAutoWrite"], true);
});
