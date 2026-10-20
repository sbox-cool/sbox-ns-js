import type { EndpointDefinition } from "./types.js";

// Identity function. Gives an endpoint module its contextual types without a wrapper object, so the same
// module can be imported by the engine loader and by this backend.
export function defineEndpoint(definition: EndpointDefinition): EndpointDefinition {
  return definition;
}
