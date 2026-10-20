import { definitionFault, documentFor, type ResourceKind } from "./catalog.js";
import { parseQuery } from "./query-routes.js";
import { isRecord } from "../util/guards.js";

// Management source upgrade: compiles one resource source into its canonical record, validates that record with the
// same compiler a management write uses, and reports whether an automatic write is safe. Nothing is written here.
// Port of the reference ManagementSourceUpgrade and NetworkStorageSourceResourceCompiler, adjusted to the SDK's DSL.

export type SourceParser = (text: string) => unknown;
export type SourceStringifier = (value: unknown) => string;

export interface SourceTools {
  parseYaml: SourceParser | undefined;
  stringifyYaml: SourceStringifier | undefined;
}

export interface UpgradeDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  sourcePath: string;
  suggestedFix?: string;
}

export interface UpgradeOutcome {
  ok: boolean;
  body: Record<string, unknown>;
}

type SourceKind = "endpoint" | "workflow" | "collection" | "query" | "test";

const SUPPORTED_KINDS: readonly SourceKind[] = ["endpoint", "workflow", "collection", "query", "test"];
const ACCEPTED_LAYOUTS = ["flat", "definition-wrapper", "mixed-definition-wrapper"];
const FAILURE_LAYOUTS = ["flat", "definition-wrapper"];
// Only features the DSL compiler implements. The reference also lists retry, onTrue/onFalse and legacy-onFail, which
// this compiler does not accept.
const SUPPORTED_FEATURES = ["exposure", "routes.true", "routes.false", "sleep", "goto", "run", "return"];
const AUTHORING_FIELDS = ["authoringMode", "sourceFormat", "sourcePath", "sourceText", "sourceVersion"];

// Source bookkeeping that is never part of the canonical definition.
const LEGACY_SOURCE_ONLY_KEYS = new Set([
  "sourceText", "sourceObject", "sourceFormat", "sourceVersion", "sourcePath", "sourcePathSystemGenerated",
  "sourceHash", "dependencyHash", "canonicalDefinition", "canonicalHash", "executionPlan", "executionPlanHash",
  "diagnostics", "compilerFingerprint", "compileStatus", "compiledAt", "previousKnownGoodPlan",
  "lastRecompileAttemptAt", "authoringMode", "legacyJson",
]);

// Top-level keys a source may carry. Anything else is an ambiguous field that no safe automatic write covers.
const TOP_LEVEL_ALLOWED = new Set([
  "sourceVersion", "kind", "resourceKind", "id", "name", "description", "notes", "imports", "metadata",
  "definition", "resource", "endpoint", "workflow", "collection", "test", "library",
]);

const KIND_ALLOWED = new Map<SourceKind, readonly string[]>([
  ["endpoint", ["slug", "method", "enabled", "exposure", "internal", "internalOnly", "skipSboxAuth", "requiresSecretKey", "requireReauth", "authPolicy", "input", "let", "steps", "response"]],
  ["workflow", ["params", "input", "steps", "returns", "condition", "requires", "onFail", "exposure", "internal", "internalOnly", "builtIn"]],
  ["collection", ["schema", "collectionType", "accessMode", "visibility", "version", "rateLimits", "rateLimitAction", "webhookOnRateLimit", "maxRecords", "allowRecordDelete", "requireSaveVersion", "constants", "tables"]],
  ["test", ["endpoint", "method", "input", "inputMode", "mockData", "expect", "skipWebhooks", "tags"]],
]);

type Compiled =
  | { ok: true; body: Record<string, unknown>; source: Record<string, unknown> | null }
  | { ok: false; message: string };

export function upgradeSource(payload: Record<string, unknown>, tools: SourceTools): UpgradeOutcome {
  const kindText = (stringOf(payload["kind"]) ?? stringOf(payload["resourceKind"]) ?? "").trim().toLowerCase();
  if (!isSourceKind(kindText)) {
    return failure(diagnostic("SOURCE_COMPILE_FAILED", `Source kind '${kindText}' cannot be upgraded.`, "/kind"));
  }
  const compiled = compileSource(payload, kindText, tools.parseYaml);
  if (!compiled.ok) return failure(diagnostic("SOURCE_COMPILE_FAILED", compiled.message, "/sourceText"));

  const canonical = canonicalOf(kindText, compiled.body);
  const diagnostics = [
    ...validateCanonical(kindText, canonical, tools.parseYaml),
    ...ambiguityDiagnostics(kindText, compiled.source),
  ];
  const upgradedSourceText = formatSource(kindText, compiled.body, canonical, tools.parseYaml, tools.stringifyYaml);
  if (upgradedSourceText === null) {
    return failure(diagnostic("SOURCE_UPGRADE_UNAVAILABLE", "Upgraded YAML needs ServerOptions.stringifyYaml.", "/sourceText"));
  }

  const seed = stringOf(payload["slug"]) ?? stringOf(payload["id"]) ?? stringOf(payload["name"]) ?? stringOf(payload["sourcePath"]) ?? kindText;
  return {
    ok: true,
    body: {
      ok: true,
      resourceKind: kindText,
      resourceId: stringOf(payload["id"]) ?? stringOf(payload["slug"]) ?? stringOf(payload["name"]) ?? "",
      sourcePath: stringOf(payload["sourcePath"]) ?? `${seed}.${kindText}.yml`,
      canonicalDefinition: canonical,
      diagnostics,
      upgradedSourceText,
      safeAutoWrite: !diagnostics.some((item) => item.severity === "error" || item.severity === "warning"),
      capabilities: { acceptedLayouts: ACCEPTED_LAYOUTS, supportedFeatures: SUPPORTED_FEATURES },
    },
  };
}

function isSourceKind(value: string): value is SourceKind {
  return (SUPPORTED_KINDS as readonly string[]).includes(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isFilled(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

function diagnostic(code: string, message: string, sourcePath: string): UpgradeDiagnostic {
  return { severity: "error", code, message, sourcePath };
}

function failure(item: UpgradeDiagnostic): UpgradeOutcome {
  return {
    ok: false,
    body: {
      ok: false,
      error: "SOURCE_UPGRADE_FAILED",
      diagnostics: [item],
      safeAutoWrite: false,
      capabilities: { acceptedLayouts: FAILURE_LAYOUTS },
    },
  };
}

// Compiles the authored source into a record body. A payload without sourceText is taken as it is.
function compileSource(payload: Record<string, unknown>, kind: SourceKind, parseYaml: SourceParser | undefined): Compiled {
  const text = payload["sourceText"];
  if (typeof text !== "string") return { ok: true, body: structuredClone(payload), source: null };
  if (text.trim() === "") return { ok: false, message: "Source text is empty." };

  let source: Record<string, unknown>;
  try {
    source = parseSourceText(text, stringOf(payload["sourceFormat"]) ?? inferFormat(stringOf(payload["sourcePath"])), parseYaml);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const declared = stringOf(source["kind"]) ?? stringOf(source["resourceKind"]);
  if (isFilled(declared) && declared.toLowerCase() !== kind) {
    return { ok: false, message: `Source kind '${declared}' does not match '${kind}'.` };
  }

  const body = unwrapBody(source, kind);
  delete body["kind"];
  delete body["resourceKind"];
  for (const field of AUTHORING_FIELDS) {
    if (Object.hasOwn(payload, field)) body[field] = structuredClone(payload[field]);
  }

  const wrapperId = stringOf(payload["id"]);
  if (!Object.hasOwn(body, "id") && isFilled(wrapperId)) body["id"] = wrapperId;
  const resolvedId = stringOf(body["id"]) ?? wrapperId;
  if (kind === "endpoint" && !Object.hasOwn(body, "slug") && isFilled(resolvedId)) body["slug"] = resolvedId;
  if ((kind === "collection" || kind === "workflow") && !Object.hasOwn(body, "name") && isFilled(resolvedId)) {
    body["name"] = resolvedId;
  }
  return { ok: true, body, source };
}

// Parses a source text the way the compiler reads it. Error messages match the reference.
function parseSourceText(text: string, format: string, parseYaml: SourceParser | undefined): Record<string, unknown> {
  if (format.toLowerCase() === "json") {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("Invalid JSON source: The root value must be an object.");
    return parsed;
  }
  if (parseYaml === undefined) throw new Error("YAML sources need ServerOptions.parseYaml.");
  const parsed = parseYaml(text);
  if (!isRecord(parsed)) throw new Error("Invalid YAML source: The root value must be a mapping.");
  return parsed;
}

function inferFormat(sourcePath: string | null): string {
  return sourcePath !== null && sourcePath.toLowerCase().endsWith(".json") ? "json" : "yaml";
}

// The definition inside a source. A `kind` or `resource` wrapper, or a `definition` wrapper, is merged with its
// outer fields. The wrapper's own key is dropped from the merge.
function unwrapBody(source: Record<string, unknown>, kind: SourceKind): Record<string, unknown> {
  const kindBody = source[kind];
  if (isRecord(kindBody)) return mergeFields(source, kindBody, [kind, "resource"]);
  const resourceBody = source["resource"];
  if (isRecord(resourceBody)) return mergeFields(source, resourceBody, ["resource", kind]);
  const definitionBody = source["definition"];
  if (isRecord(definitionBody)) return mergeFields(definitionBody, source, ["definition", kind, "resource"]);
  return structuredClone(source);
}

// Later fields win. Exclusions match case-insensitively, as the reference's comparer does.
function mergeFields(first: Record<string, unknown>, second: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  const skip = new Set(excluded.map((key) => key.toLowerCase()));
  const merged: Record<string, unknown> = {};
  for (const fields of [first, second]) {
    for (const [key, value] of Object.entries(fields)) {
      if (!skip.has(key.toLowerCase())) merged[key] = structuredClone(value);
    }
  }
  return merged;
}

// The canonical record keeps only fields the upgrade recognises. Unrecognised fields are reported as warnings by
// ambiguityDiagnostics and are never carried into the validated record.
function canonicalOf(kind: SourceKind, compiled: Record<string, unknown>): Record<string, unknown> {
  const allowed = allowedFieldsOf(kind);
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(compiled)) {
    if (LEGACY_SOURCE_ONLY_KEYS.has(key) || key === "kind" || key === "resourceKind" || !allowed.has(key)) continue;
    canonical[key] = structuredClone(value);
  }
  return canonical;
}

function allowedFieldsOf(kind: SourceKind): Set<string> {
  return new Set([...TOP_LEVEL_ALLOWED, ...(KIND_ALLOWED.get(kind) ?? [])]);
}

// Validates the canonical record with the compiler a management write uses. Endpoint, collection and workflow records
// compile through the same document mapping as a stored record, so a passing check means the write would be accepted.
function validateCanonical(kind: SourceKind, canonical: Record<string, unknown>, parseYaml: SourceParser | undefined): UpgradeDiagnostic[] {
  if (kind === "query") {
    try {
      parseQuery(canonical);
      return [];
    } catch (error) {
      return [diagnostic("SOURCE_DEFINITION_INVALID", error instanceof Error ? error.message : String(error), "/")];
    }
  }
  if (kind === "test") {
    if (typeof canonical["id"] !== "string") return [diagnostic("SOURCE_DEFINITION_INVALID", "Each test needs an id and an endpoint.", "/id")];
    if (typeof canonical["endpoint"] !== "string") {
      return [diagnostic("SOURCE_DEFINITION_INVALID", "Each test needs an id and an endpoint.", "/endpoint")];
    }
    return [];
  }
  const findings = kind === "collection" ? collectionDiagnostics(canonical) : [];
  if (findings.some((item) => item.severity === "error")) return findings;
  const fault = definitionFault(storeKindOf(kind), canonical, parseYaml);
  return fault === null ? findings : [...findings, diagnostic("SOURCE_DEFINITION_INVALID", fault.message, fault.path)];
}

const COLLECTION_TYPES: readonly string[] = ["per-steamid", "global", "player"];
const COLLECTION_ACCESS_MODES: readonly string[] = ["public", "endpoint", "private"];

function isIntegerIn(value: unknown, low: number, high: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

// The top-level collection checks of the reference schema validator (NetworkStorageSchemaValidator.ValidateCollection).
// The schema walk is covered by definitionFault. Warnings do not block the upgrade; errors are reported and refuse it.
function collectionDiagnostics(canonical: Record<string, unknown>): UpgradeDiagnostic[] {
  const findings: UpgradeDiagnostic[] = [];
  const collectionType = canonical["collectionType"];
  if (collectionType !== undefined && (typeof collectionType !== "string" || !COLLECTION_TYPES.includes(collectionType))) {
    findings.push({
      severity: "warning",
      code: "COLLECTION_TYPE",
      message: "collectionType should be per-steamid (one record per player) or global (shared records). Anything else is stored per player.",
      sourcePath: "/collectionType",
    });
  }
  const accessMode = canonical["accessMode"];
  if (typeof accessMode === "string" && !COLLECTION_ACCESS_MODES.includes(accessMode)) {
    findings.push({
      severity: "warning",
      code: "ACCESS_MODE",
      message: "accessMode should be public (game clients write records directly) or endpoint (only endpoints write).",
      sourcePath: "/accessMode",
    });
  }
  if (canonical["maxRecords"] !== undefined && !isIntegerIn(canonical["maxRecords"], 1, 50)) {
    findings.push(diagnostic("INVALID_MAX_RECORDS", "maxRecords must be a whole number from 1 to 50 (save slots per player).", "/maxRecords"));
  }
  for (const flag of ["allowRecordDelete", "requireSaveVersion", "webhookOnRateLimit"]) {
    if (canonical[flag] !== undefined && typeof canonical[flag] !== "boolean") {
      findings.push(diagnostic("INVALID_FLAG", `${flag} must be true or false.`, `/${flag}`));
    }
  }
  const action = canonical["rateLimitAction"];
  if (typeof action === "string" && action !== "reject" && action !== "clamp") {
    findings.push(diagnostic("INVALID_RATE_LIMIT_ACTION", "rateLimitAction must be reject or clamp.", "/rateLimitAction"));
  }
  const rateLimits = canonical["rateLimits"];
  if (rateLimits !== undefined) {
    if (typeof rateLimits !== "object" || rateLimits === null || Array.isArray(rateLimits)) {
      findings.push(diagnostic("INVALID_RATE_LIMITS", "rateLimits must be an object with mode and savesPerDay.", "/rateLimits"));
    } else {
      const limits = rateLimits as Record<string, unknown>;
      const mode = limits["mode"];
      if (typeof mode === "string" && mode !== "player" && mode !== "collection") {
        findings.push(diagnostic("INVALID_RATE_LIMITS", "rateLimits.mode must be player or collection.", "/rateLimits/mode"));
      }
      if (limits["savesPerDay"] !== undefined && !isIntegerIn(limits["savesPerDay"], 1, 10_000_000)) {
        findings.push(diagnostic("INVALID_RATE_LIMITS", "rateLimits.savesPerDay must be a whole number from 1 to 10000000.", "/rateLimits/savesPerDay"));
      }
    }
  }
  return findings;
}

function storeKindOf(kind: "endpoint" | "workflow" | "collection"): ResourceKind {
  if (kind === "endpoint") return "endpoints";
  return kind === "collection" ? "collections" : "workflows";
}

// Warns about top-level fields the upgrade does not recognise, so they are never silently dropped.
function ambiguityDiagnostics(kind: SourceKind, source: Record<string, unknown> | null): UpgradeDiagnostic[] {
  if (source === null) return [];
  const allowed = allowedFieldsOf(kind);
  return Object.keys(source)
    .filter((key) => !allowed.has(key))
    .map((key) => ({
      severity: "warning",
      code: "SOURCE_UPGRADE_AMBIGUOUS_FIELD",
      message: `Source field "${key}" is not recognized by backend upgrade and was not auto-written as a safe upgrade.`,
      sourcePath: key,
      suggestedFix: "Remove or rename the field, then retry the upgrade.",
    }));
}

// A source that carries its own text is returned verbatim (BOM removed, LF line endings). Otherwise the canonical
// record is written as the authored DSL document, the form the compiler reads from sourceText. Returns null when YAML
// output is needed and no writer is configured.
function formatSource(
  kind: SourceKind,
  compiled: Record<string, unknown>,
  canonical: Record<string, unknown>,
  parseYaml: SourceParser | undefined,
  stringifyYaml: SourceStringifier | undefined,
): string | null {
  const text = compiled["sourceText"];
  if (typeof text === "string" && text.trim() !== "") {
    return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  }
  if (stringifyYaml === undefined) return null;
  const yaml = stringifyYaml(authoredDocument(kind, canonical, parseYaml));
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

// Query and test records are stored as their canonical fields, so the text is the canonical record. When an endpoint,
// collection or workflow record cannot be mapped to a document, the canonical record is written and the validation
// diagnostic reports why; a safe write is never reported for it.
function authoredDocument(kind: SourceKind, canonical: Record<string, unknown>, parseYaml: SourceParser | undefined): Record<string, unknown> {
  if (kind === "query" || kind === "test") return canonical;
  try {
    return documentFor(storeKindOf(kind), canonical, parseYaml);
  } catch {
    return canonical;
  }
}
