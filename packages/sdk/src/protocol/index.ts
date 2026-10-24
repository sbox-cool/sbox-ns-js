// Public protocol surface. Envelope and crypto internals stay private; consumers reach them through the server.
export {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  MAX_REPLAY_WINDOW_SECONDS,
  MIN_REPLAY_WINDOW_SECONDS,
  clampReplayWindow,
  createMemoryReplayStore,
} from "./replay.js";
export type { ReplayCheck, ReplayStore } from "./replay.js";
export { ProtocolError, isProtocolError } from "./errors.js";
export { isLibraryCaller, libraryErrorBody, parseClientType } from "./library.js";
export type { LibraryErrorInput } from "./library.js";
export {
  SECURITY_CONFIG_TTL_SECONDS,
  buildSecurityConfig,
  securityConfigVersion,
  securitySettingsDocument,
} from "./config.js";
export type { SecurityConfigInput, SecuritySettings, SignedSecurityConfig } from "./config.js";
