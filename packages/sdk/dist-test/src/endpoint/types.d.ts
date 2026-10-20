import type { RecordData } from "../storage/types.js";
import type { FetchResponseData } from "./fetch.js";
export type { RecordData };
export type MaybePromise<T> = T | Promise<T>;
export interface EndpointRequest {
    input: Record<string, unknown>;
    player: {
        steamId: string;
    } | null;
    method: "GET" | "POST";
    endpoint: string;
    revision: string | null;
}
export interface NsRecords {
    get(collection: string, key: string): MaybePromise<RecordData | null>;
    put(collection: string, key: string, data: RecordData): MaybePromise<void>;
    delete(collection: string, key: string): MaybePromise<void>;
    list(collection: string): MaybePromise<RecordData[]>;
}
export interface NsValues {
    get(path: string): MaybePromise<unknown>;
}
export type FetchMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface FetchOptions {
    method?: FetchMethod;
    headers?: Record<string, string>;
    body?: string | Record<string, unknown> | unknown[];
    timeoutMs?: number;
}
export type FetchResponse = FetchResponseData;
export interface Ns {
    records: NsRecords;
    values: NsValues;
    now(): number;
    log(value: unknown): void;
    fail(code: string, message: string, status?: number): never;
    fetch(url: string, options?: FetchOptions): FetchResponse | null;
}
export type EndpointHandler = (req: EndpointRequest, ns: Ns) => unknown;
export interface EndpointDefinition {
    handle: EndpointHandler;
}
