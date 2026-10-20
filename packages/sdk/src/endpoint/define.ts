import type { EndpointGlobal, EndpointHandler, WorkflowFunction } from "./types.js";

// Identity helpers. Each takes the module's function, gives it contextual types, and returns it unchanged, so
// the same file runs on a custom backend and on an sbox-ns server.
export function defineEndpoint(handle: EndpointHandler): EndpointHandler {
  return handle;
}

export function defineGlobal(fn: EndpointGlobal): EndpointGlobal {
  return fn;
}

export function defineWorkflow(fn: WorkflowFunction): WorkflowFunction {
  return fn;
}
