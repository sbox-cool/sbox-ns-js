import { createMemoryStorage } from "../src/storage/index.js";
import { runConformance } from "./storage/conformance.js";

runConformance({
  name: "memory",
  persistent: false,
  open: (config) => createMemoryStorage(config),
});
