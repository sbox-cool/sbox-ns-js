import { ScriptFailure } from "../endpoint/runtime.js";
import type { EndpointHandler, Ns, ScriptBridge, ScriptModule } from "../endpoint/types.js";

// A scripted endpoint's handler: one sandbox pass. The script's ns calls are answered by `ns` of this pass, so reads
// that are not loaded yet return null and the engine re-runs the pass, exactly as for a DSL handler.
export function scriptHandler(entry: ScriptModule): EndpointHandler {
  return (request, ns, scope) => {
    if (scope.scripts === undefined) {
      throw new ScriptFailure("SCRIPTS_DISABLED", "Scripted endpoints are not available on this server.", 503);
    }
    return scope.scripts.run(entry, request, scriptBridge(ns));
  };
}

// Maps the guest's ns calls onto the host ns. Arguments arrive as JSON; `null` stands for an omitted optional argument.
export function scriptBridge(ns: Ns): ScriptBridge {
  return (op, args) => {
    switch (op) {
      case "records.get":
        return ns.records.get(args[0] as string, args[1] as string);
      case "records.put":
        return ns.records.put(args[0] as string, args[1] as string, args[2] as Record<string, unknown>);
      case "records.delete":
        return ns.records.delete(args[0] as string, args[1] as string);
      case "records.list":
        return ns.records.list(args[0] as string);
      case "values.get":
        return ns.values.get(args[0] as string);
      case "workflows.run":
        return ns.workflows.run(args[0] as string, args[1] === null ? undefined : (args[1] as Record<string, unknown>));
      case "secrets.get":
        return ns.secrets.get(args[0] as string);
      case "now":
        return ns.now();
      case "log":
        return ns.log(args[0]);
      case "fail":
        return failFromScript(ns, args[0], args[1], args[2]);
      case "fetch":
        return ns.fetch(args[0] as string, args[1] === null ? undefined : (args[1] as Parameters<Ns["fetch"]>[1]));
      default:
        throw new Error(`Unknown script call: ${op}`);
    }
  };
}

// ns.fail as the server enforces it: a status from 400 to 499 (default 400) and a non-empty code. A call that breaks
// either rule throws an ordinary error into the script, as the server's argument check does: uncaught, it ends the run
// as SCRIPT_ERROR; it records no failure, so a script may catch it.
function failFromScript(ns: Ns, code: unknown, message: unknown, status: unknown): never {
  const httpStatus = status === null ? 400 : status;
  if (typeof httpStatus !== "number" || !Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 499) {
    throw new Error("ns.fail status must be between 400 and 499.");
  }
  if (typeof code !== "string" || code.trim() === "") throw new Error("ns.fail needs an error code.");
  return ns.fail(code, typeof message === "string" ? message : "", httpStatus);
}
