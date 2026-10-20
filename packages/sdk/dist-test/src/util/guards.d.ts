/** Narrows to a JSON object. Fields stay `unknown`; read each one with a type check at the point of use. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
