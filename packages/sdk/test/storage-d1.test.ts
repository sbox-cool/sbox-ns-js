// Runs the shared conformance suite against D1 through the recipes/cloudflare-kv harness under `wrangler dev`.
// Skipped unless NS_TEST_HARNESS_URL is set.
import { runConformance } from "./storage/conformance.js";
import { harnessSkip, harnessUrl, remoteFixture } from "./storage/remote.js";

runConformance(remoteFixture("d1", harnessUrl, harnessSkip));
