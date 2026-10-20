import type { EndpointStorage, RecordWrite } from "../storage/types.js";
import { type FetchPolicy } from "./fetch.js";
import type { EndpointDefinition, EndpointRequest } from "./types.js";
export declare class ScriptFailure extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number);
}
export interface RunEnvironment {
    storage: EndpointStorage;
    fetchPolicy: FetchPolicy;
    now: () => number;
    log: (value: unknown) => void;
}
export interface RunOutcome {
    value: unknown;
    writes: RecordWrite[];
}
export declare function runEndpoint(definition: EndpointDefinition, request: EndpointRequest, env: RunEnvironment): Promise<RunOutcome>;
