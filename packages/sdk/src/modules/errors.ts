export type ModuleErrorCode =
  | "INVALID_MODULE"
  | "MODULE_CONFLICT"
  | "MODULE_UNSUPPORTED"
  | "INVALID_RESPONSE";

export interface ModuleErrorInit {
  code: ModuleErrorCode;
  message: string;
  /** Per-record failures, when the module definition does not compile. */
  details?: readonly { id: string; message: string }[];
}

/** A module definition, install, or uninstall failed. Invalid definitions are rejected before any write. */
export class ModuleError extends Error {
  readonly code: ModuleErrorCode;
  readonly details: readonly { id: string; message: string }[];

  constructor(init: ModuleErrorInit) {
    super(init.message);
    this.name = "ModuleError";
    this.code = init.code;
    this.details = init.details ?? [];
  }
}

export function isModuleError(value: unknown): value is ModuleError {
  return value instanceof ModuleError;
}
