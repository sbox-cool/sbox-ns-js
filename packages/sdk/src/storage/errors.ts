export type StorageErrorCode =
  | "UNKNOWN_COLLECTION"
  | "INVALID_COLLECTION"
  | "INVALID_KEY"
  | "INVALID_RECORD"
  | "RECORD_TOO_LARGE"
  | "SCHEMA_VIOLATION"
  | "INVALID_BATCH"
  | "UNOBSERVED_WRITE"
  | "CONFLICT"
  | "RECORD_LIMIT_REACHED"
  | "STORAGE_UNAVAILABLE"
  | "INVALID_STORAGE_CONFIG";

const STATUS: Record<StorageErrorCode, number> = {
  UNKNOWN_COLLECTION: 500,
  INVALID_COLLECTION: 500,
  INVALID_KEY: 400,
  INVALID_RECORD: 400,
  RECORD_TOO_LARGE: 413,
  SCHEMA_VIOLATION: 400,
  INVALID_BATCH: 400,
  UNOBSERVED_WRITE: 409,
  CONFLICT: 409,
  RECORD_LIMIT_REACHED: 409,
  STORAGE_UNAVAILABLE: 503,
  INVALID_STORAGE_CONFIG: 500,
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status: number;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.status = STATUS[code];
  }
}
