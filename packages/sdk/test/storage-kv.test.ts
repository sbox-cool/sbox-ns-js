// Runs the shared conformance suite against KV (Durable Object coordinator + KV blobs) through the
// recipes/cloudflare-kv harness under `wrangler dev`. Skipped unless NS_TEST_HARNESS_URL is set.
// KV is eventually consistent for reads outside the coordinator; see docs for the exact semantics.
import { runConformance } from "./storage/conformance.js";
import { harnessSkip, harnessUrl, remoteFixture } from "./storage/remote.js";

runConformance(remoteFixture("kv", harnessUrl, harnessSkip));
