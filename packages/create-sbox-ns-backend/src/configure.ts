// The game-side line that points an s&box project at a backend. It carries the public key only; the secret key
// never leaves the server project.
export interface ConfigureInput {
  projectId: string;
  publicKey: string;
  baseUrl: string;
}

// A value is embedded in a C# string literal, so it must be non-empty and contain no quote or line break.
const PLAIN_VALUE = /^[^"\r\n]+$/;

export function networkStorageConfigureLine(input: ConfigureInput): string {
  for (const [name, value] of Object.entries(input)) {
    if (!PLAIN_VALUE.test(value)) {
      throw new Error(`${name} must be non-empty and contain no quotes or line breaks.`);
    }
  }
  const url = new URL(input.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https.");
  }
  return `NetworkStorage.Configure( "${input.projectId}", "${input.publicKey}", "${input.baseUrl}" );`;
}
