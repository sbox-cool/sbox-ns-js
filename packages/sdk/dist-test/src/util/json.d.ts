/**
 * Encodes a string exactly as the server's .NET JSON writer does (UnsafeRelaxedJsonEscaping on .NET 10).
 * Lone surrogates become U+FFFD, supplementary characters are written as escaped UTF-16 pairs, and the
 * BMP escape set comes from the generated table in dotnet-escape-ranges.ts.
 */
export declare function dotnetJsonString(value: string): string;
/**
 * Serializes a value with object keys in ordinal (code unit) order at every depth. The server builds
 * every AAD, signature binding and config digest from this form, so the output must match byte for byte.
 */
export declare function stableJson(value: unknown): string;
