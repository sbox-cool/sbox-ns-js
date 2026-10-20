export type RecordData = {
    [field: string]: unknown;
};
export interface StoredRecord {
    key: string;
    data: RecordData;
}
export type RecordWrite = {
    op: "put";
    collection: string;
    key: string;
    data: RecordData;
} | {
    op: "delete";
    collection: string;
    key: string;
};
export interface RecordStore {
    get(collection: string, key: string): Promise<RecordData | null>;
    list(collection: string): Promise<StoredRecord[]>;
}
export interface ValueStore {
    get(path: string): Promise<unknown>;
}
export interface EndpointStorage {
    records: RecordStore;
    values: ValueStore;
    apply(writes: readonly RecordWrite[]): Promise<void>;
}
