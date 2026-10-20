// Port of SboxNetworkStorage.Server/Owner/OwnerRecordValidation.cs. Same keyword set, same
// standard-schema detection, same bare field-map form, same error paths and messages.
// "datetime" follows the server's DateTimeOffset.TryParse for ISO 8601 / RFC 3339 forms, with calendar and
// clock bounds. Known difference: .NET also accepts other invariant-culture forms (e.g. "March 5, 2024"); those are rejected here.
import { isValidRecordKey } from "./keys.js";
import { isPlainObject } from "./json.js";

// Calendar- and clock-checked ISO 8601 / RFC 3339 date-time. Date.parse is not used because it silently
// normalizes impossible dates (2024-02-30 becomes 2024-03-01).
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/;

function isDateTime(value: string): boolean {
  const match = DATETIME.exec(value);
  if (!match) return false;
  const [, year = "", month = "", day = "", hour = "0", minute = "0", second = "0", sign, offsetHour = "0", offsetMinute = "0"] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (sign !== undefined) {
    const oh = Number(offsetHour);
    const om = Number(offsetMinute);
    if (om > 59 || oh > 14 || (oh === 14 && om > 0)) return false;
  }
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "enum", "items",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "description", "title", "default", "$schema",
]);

const MAX_DEPTH = 64;
const INT32_MAX = 2147483647;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -INT32_MAX - 1 && value <= INT32_MAX;
}

// Returns the first violation message (with its path), or null when the value conforms.
export function schemaViolation(schema: Record<string, unknown>, value: Record<string, unknown>): string | null {
  return node(schema, value, "$", 0);
}

function node(schema: unknown, value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `${path}: schema nesting exceeds ${MAX_DEPTH} levels.`;
  if (typeof schema === "string") return checkType(schema, value, path);
  if (schema === false) return `${path}: the collection schema does not allow this value.`;
  if (schema === true) return null;
  if (!isPlainObject(schema)) return `${path}: invalid collection schema.`;

  const declaredType = hasOwn(schema, "type") ? schema.type : undefined;
  const standard = !isPlainObject(value)
    || hasOwn(schema, "properties") || hasOwn(schema, "enum") || hasOwn(schema, "required")
    || hasOwn(schema, "additionalProperties") || hasOwn(schema, "$ref")
    || (hasOwn(schema, "type") && !isPlainObject(declaredType)
      && Object.keys(schema).every((key) => KEYWORDS.has(key)));

  if (standard) {
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.has(key)) {
        return `${path}: collection schema modifier '${key}' is not supported by the record editor.`;
      }
    }
    for (const [key, keyword] of Object.entries(schema)) {
      if (!keywordIsValid(key, keyword)) return `${path}: invalid '${key}' in the collection schema.`;
    }
  }

  if (typeof declaredType === "string") {
    const typeError = checkType(declaredType, value, path);
    if (typeError) return typeError;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((choice) => jsonEqual(choice, value))) {
    return `${path}: value is not in the allowed enum.`;
  }

  if (isPlainObject(value)) {
    const objectError = checkObject(schema, value, path, depth);
    if (objectError) return objectError;
  }

  if (Array.isArray(value)) {
    const arrayError = checkArray(schema, value, path, depth);
    if (arrayError) return arrayError;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (isInt32(schema.minLength) && length < schema.minLength) {
      return `${path}: must contain at least ${schema.minLength} characters.`;
    }
    if (isInt32(schema.maxLength) && length > schema.maxLength) {
      return `${path}: must contain at most ${schema.maxLength} characters.`;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${path}: must be at least ${schema.minimum}.`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${path}: must be at most ${schema.maximum}.`;
    }
  }

  return null;
}

function checkObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  depth: number,
): string | null {
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !hasOwn(value, key)) {
        return `${path}.${key}: required field is missing.`;
      }
    }
  }

  const properties = schemaProperties(schema);
  const additional = hasOwn(schema, "additionalProperties") ? schema.additionalProperties : undefined;
  const disallowExtra = additional === false;

  for (const name of Object.keys(value)) {
    if (hasOwn(properties, name)) {
      const error = node(properties[name], value[name], `${path}.${name}`, depth + 1);
      if (error) return error;
    } else if (disallowExtra) {
      return `${path}.${name}: additional fields are not allowed.`;
    } else if (isPlainObject(additional)) {
      const error = node(additional, value[name], `${path}.${name}`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

function checkArray(
  schema: Record<string, unknown>,
  value: unknown[],
  path: string,
  depth: number,
): string | null {
  if (isInt32(schema.minItems) && value.length < schema.minItems) {
    return `${path}: must contain at least ${schema.minItems} items.`;
  }
  if (isInt32(schema.maxItems) && value.length > schema.maxItems) {
    return `${path}: must contain at most ${schema.maxItems} items.`;
  }
  if (hasOwn(schema, "items")) {
    for (let index = 0; index < value.length; index++) {
      const error = node(schema.items, value[index], `${path}[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

// Mirrors CollectionSchemaHelpers.GetSchemaProperties: an explicit "properties" object wins;
// otherwise a bare field map ({"score":"number"}) is the property map itself.
function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  if (hasOwn(schema, "properties") && isPlainObject(schema.properties)) {
    return schema.properties;
  }
  return isBareFieldMap(schema) ? schema : {};
}

function isBareFieldMap(schema: Record<string, unknown>): boolean {
  const keys = Object.keys(schema);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (key.toLowerCase() === "type") continue;
    const value = schema[key];
    if (typeof value === "string" || isPlainObject(value)) continue;
    return false;
  }
  return keys.some((key) => key.toLowerCase() !== "type");
}

function keywordIsValid(key: string, value: unknown): boolean {
  switch (key) {
    case "type":
      return typeof value === "string";
    case "properties":
      return isPlainObject(value);
    case "required":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "enum":
      return Array.isArray(value);
    case "additionalProperties":
      return isPlainObject(value) || typeof value === "boolean";
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      return isInt32(value) && value >= 0;
    case "minimum":
    case "maximum":
      return typeof value === "number";
    default:
      return true;
  }
}

function checkType(type: string, value: unknown, path: string): string | null {
  let valid: boolean;
  switch (type) {
    case "object":
      valid = isPlainObject(value);
      break;
    case "array":
      valid = Array.isArray(value);
      break;
    case "string":
      valid = typeof value === "string";
      break;
    case "number":
      valid = typeof value === "number";
      break;
    case "integer":
      valid = typeof value === "number" && Number.isInteger(value);
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "player":
    case "playerSave":
      valid = typeof value === "string" && isValidRecordKey(value);
      break;
    case "datetime":
      valid = typeof value === "string" && isDateTime(value);
      break;
    case "null":
      valid = value === null;
      break;
    case "":
      valid = true;
      break;
    default:
      valid = false;
  }
  return valid ? null : `${path}: expected ${type}.`;
}

// Deep JSON equality, matching the server's Equal(): same kind, same members, same order for arrays.
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (Array.isArray(right) || !isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
