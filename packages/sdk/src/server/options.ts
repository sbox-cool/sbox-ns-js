import type { FetchPolicy } from "../endpoint/fetch.js";
import type { SecretStore } from "../endpoint/runtime.js";
import type { EndpointDefinition, EndpointGlobal, WorkflowFunction } from "../endpoint/types.js";
import type { SecuritySettings } from "../protocol/config.js";
import type { RequestKeyRing } from "../protocol/crypto.js";
import type { ReplayStore } from "../protocol/replay.js";
import type { EndpointStorage } from "../storage/types.js";

// Records logouts. Auth session tokens are stateless and expire on their own; revocation needs a shared
// store to be enforced across processes. The SDK ships an in-process store and never claims cross-instance
// revocation unless the caller supplies a shared one.
export interface SessionRevocations {
  revoke(sessionId: string, expiresAtMs: number): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

export interface ValuesDocument {
  groups: Readonly<Record<string, unknown>>;
  tables: Readonly<Record<string, unknown>>;
}

export interface ServerOptions {
  projectId: string;
  // Public key the game and editor send as x-public-key. Safe to ship in client code.
  publicKey: string;
  // Secret key for dedicated servers and owner tooling. Null disables secret-key access.
  secretKey: string | null;
  ownerUserId: number;
  settings: SecuritySettings;
  // PKCS#8 RSA PEM. Signs the security config the game verifies.
  signingPrivateKeyPem: string;
  signingKeyId?: string;
  requestKeys?: RequestKeyRing;
  // Requires verified s&box identity tokens for player-scoped calls. Defaults to false.
  requireSboxAuth?: boolean;
  // HMAC secret for auth session tokens. Null means auth sessions are unavailable.
  sessionSecret: string | null;
  sessionRevocations?: SessionRevocations;
  endpoints: Readonly<Record<string, EndpointDefinition>>;
  workflows?: Readonly<Record<string, WorkflowFunction>>;
  globals?: Readonly<Record<string, Readonly<Record<string, EndpointGlobal>>>>;
  secrets?: SecretStore;
  values?: ValuesDocument;
  storage: EndpointStorage;
  fetchPolicy: FetchPolicy;
  replayStore: ReplayStore;
  now?: () => number;
  log?: (value: unknown) => void;
}
