import type { EndpointStorage, RecordData } from "./types.js";
export interface MemoryStorageSeed {
    records?: Record<string, Record<string, RecordData>>;
    values?: Record<string, unknown>;
}
export declare function createMemoryStorage(seed?: MemoryStorageSeed): EndpointStorage;
