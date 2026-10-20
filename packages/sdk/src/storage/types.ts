export type RecordData = { [field: string]: unknown };

export interface StoredRecord {
  key: string;
  data: RecordData;
  version: number;
}

// version is 0 when the record never existed. Deleted per-player records keep their last version
// (a tombstone), so a later create continues the sequence instead of restarting at 1.
export interface VersionedRecord {
  data: RecordData | null;
  version: number;
}

export type RecordWrite =
  | { op: "put"; collection: string; key: string; data: RecordData }
  | { op: "delete"; collection: string; key: string };

// The version an endpoint observed for a record during its run. apply() checks every entry against
// the current state inside the same atomic unit as the writes.
export interface ExpectedVersion {
  collection: string;
  key: string;
  version: number;
}

export interface ApplyOptions {
  expectedVersions?: readonly ExpectedVersion[];
}

export interface RecordStore {
  get(collection: string, key: string): Promise<RecordData | null>;
  getVersioned(collection: string, key: string): Promise<VersionedRecord>;
  list(collection: string): Promise<StoredRecord[]>;
}

export interface ValueStore {
  // "group" or "group.key". Resolves to null when absent.
  get(path: string): Promise<unknown>;
}

export interface EndpointStorage {
  readonly records: RecordStore;
  readonly values: ValueStore;
  apply(writes: readonly RecordWrite[], options?: ApplyOptions): Promise<void>;
}

export type CollectionType = "per-steamid" | "global";
export type AccessMode = "public" | "endpoint" | "private";

// Mirrors the collection YAML keys the server compiles. Unknown keys are ignored.
export interface CollectionDefinition {
  id: string;
  name?: string;
  collectionType?: CollectionType | (string & {});
  accessMode?: AccessMode | (string & {});
  maxRecords?: number;
  allowRecordDelete?: boolean;
  requireSaveVersion?: boolean;
  schema?: unknown;
}
