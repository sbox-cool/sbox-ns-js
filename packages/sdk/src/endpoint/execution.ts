import type { Ns } from "./types.js";

// "scripted" runs are server-script endpoints and workflows: they never wait on sleep or send webhooks.
// "declarative" runs are catalog endpoints: their effects are performed by the runtime.
export type ExecutionMode = "scripted" | "declarative";

// Internal channel between the DSL interpreter and the run that drives it. Not part of the public Ns surface.
export interface RunInternals {
  readonly mode: ExecutionMode;
  // Returns the value memoized for this run under the name's current occurrence. compute runs once per run, so a
  // value computed in a discarded pass (random numbers, for example) is the same value every later pass sees.
  memo<T>(name: string, compute: () => T): T;
  // Performs a side effect once per run. The first call registers perform and suspends the pass. The runtime awaits
  // perform, memoizes its result, and reruns the handler, which then receives that result from this call.
  effect<T>(name: string, perform: (signal: AbortSignal | undefined) => Promise<T>): T;
}

export const RUN_INTERNALS: unique symbol = Symbol("sbox-ns.run-internals");

export function internalsOf(ns: Ns): RunInternals {
  const internals = (ns as Partial<Record<typeof RUN_INTERNALS, RunInternals>>)[RUN_INTERNALS];
  if (internals === undefined) throw new TypeError("This ns object is not bound to an endpoint run.");
  return internals;
}
