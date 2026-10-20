/** Narrows to a JSON object. Fields stay `unknown`; read each one with a type check at the point of use. */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
