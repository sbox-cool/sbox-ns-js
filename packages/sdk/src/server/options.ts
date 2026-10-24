import type { FetchPolicy } from "../endpoint/fetch.js";
import type { SecretStore } from "../endpoint/runtime.js";
import type { EndpointGlobal, EndpointHandler, WorkflowFunction } from "../endpoint/types.js";
import type { SecuritySettings } from "../protocol/config.js";
import type { RequestKeyRing } from "../protocol/crypto.js";
import type { ReplayStore } from "../protocol/replay.js";
import type { CollectionDefinition, EndpointStorage } from "../storage/types.js";
import type { ControlStateOptions } from "./control-state.js";

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
  endpoints: Readonly<Record<string, EndpointHandler>>;
  workflows?: Readonly<Record<string, WorkflowFunction>>;
  globals?: Readonly<Record<string, Readonly<Record<string, EndpointGlobal>>>>;
  secrets?: SecretStore;
  values?: ValuesDocument;
  // Builds the storage for the current collection and value definitions. The server calls it again whenever
  // management sync changes either, so the factory must reopen the same backing store each time.
  storage: StorageFactory;
  // Opt-in durable control state (source metadata, managed settings, staged revision). Without it the control state is
  // held in memory and lost on restart. See docs/storage.md for the single-writer and recovery rules.
  controlState?: ControlStateOptions;
  // Parses YAML source documents uploaded through management sync. Without one, YAML sources are rejected.
  parseYaml?: (text: string) => unknown;
  // Writes the YAML text returned by source upgrade. Without one, upgrade cannot produce YAML and fails.
  stringifyYaml?: (value: unknown) => string;
  fetchPolicy: FetchPolicy;
  replayStore: ReplayStore;
  now?: () => number;
  log?: (value: unknown) => void;
}

export interface StorageDefinition {
  collections: readonly CollectionDefinition[];
  values: Record<string, unknown>;
}

export type StorageFactory = (definition: StorageDefinition) => EndpointStorage;
