import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { networkStorageConfigureLine } from "./configure.js";
import { projectFiles } from "./templates.js";

export interface ScaffoldOptions {
  // Target directory. Created when missing. A non-empty directory is always refused.
  dir: string;
  projectId?: string;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  port?: number;
}

export interface ScaffoldResult {
  dir: string;
  files: readonly string[];
  projectId: string;
  publicKey: string;
  baseUrl: string;
  configureLine: string;
}

const DEFAULT_PORT = 8080;
const SECRET_PREFIX = "sbox_ns_sk_";
const PUBLIC_PREFIX = "sbox_ns_pk_";

export function scaffoldBackend(options: ScaffoldOptions): ScaffoldResult {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} is not empty. Choose an empty or missing directory.`);
  }

  const projectId = options.projectId ?? `proj_${randomBytes(12).toString("hex")}`;
  const publicKey = options.publicKey ?? `${PUBLIC_PREFIX}${randomBytes(24).toString("base64url")}`;
  const secretKey = options.secretKey ?? `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  const port = options.port ?? DEFAULT_PORT;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;

  // The public key ships to game clients. A secret key in that slot would publish it.
  if (publicKey.startsWith(SECRET_PREFIX)) throw new Error("The public key must not use the secret key prefix.");
  if (publicKey === secretKey) throw new Error("The public key and secret key must differ.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1-65535.");

  const configureLine = networkStorageConfigureLine({ projectId, publicKey, baseUrl });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sessionSecret = randomBytes(32).toString("base64url");

  const files = projectFiles({ configureLine, port });
  const written: string[] = [];
  const write = (relative: string, content: string, mode?: number): void => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined) chmodSync(path, mode);
    written.push(relative);
  };

  for (const [relative, content] of Object.entries(files)) write(relative, content);

  const env = [
    `PROJECT_ID=${projectId}`,
    `PUBLIC_KEY=${publicKey}`,
    `SECRET_KEY=${secretKey}`,
    `SESSION_SECRET=${sessionSecret}`,
    `SIGNING_KEY_FILE=keys/signing-private.pem`,
    `DATA_FILE=data/sbox-ns.sqlite`,
    `DEFINITIONS_DIR="Editor/Network Storage"`,
    `PORT=${port}`,
    `HOST=0.0.0.0`,
    `FETCH_ALLOWED_HOSTS=`,
    "",
  ].join("\n");
  write(".env", env, 0o600);
  write("keys/signing-private.pem", privateKey, 0o600);
  write("configure.txt", `${configureLine}\n`);

  return { dir, files: written.sort(), projectId, publicKey, baseUrl, configureLine };
}
