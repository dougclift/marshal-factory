import "./test-guard";
import assert from "node:assert/strict";

const { configSchema, linearConfigured, loadConfig } = await import("../lib/config");
const { ingestBaseUrl } = await import("../lib/ingest-url");
const { createLinearAdapter } = await import("../lib/sources/linear");

const base = { ingestUrl: "https://ingest.example/ingest", secret: "s" };
const without = configSchema.parse(base);
assert.equal(without.linearApiKey, undefined, "a config file with no linearApiKey loads");
assert.equal(linearConfigured(without), false);
assert.equal(without.factory.label, "factory", "factory limits still default");
assert.equal(configSchema.parse({ ...base, linearApiKey: "lin_key" }).linearApiKey, "lin_key", "a key still loads when it is set");
assert.equal(configSchema.safeParse({ ...base, linearApiKey: "" }).success, false, "an empty key is not a key");
assert.equal(configSchema.safeParse({ secret: "s" }).success, false, "ingestUrl stays required");
assert.equal(configSchema.safeParse({ ingestUrl: "https://ingest.example/ingest" }).success, false, "secret stays required");
assert.equal(loadConfig().linearApiKey, "test-only", "a regression run still gets a stand-in key, so the real client refuses");

assert.equal(ingestBaseUrl({ NEON_FUNCTION_INGEST_BASE_URL: "https://old.example/base/" }), "https://old.example/base", "the old variable still wins, without a trailing slash");
assert.equal(
  ingestBaseUrl({ NEON_BRANCH_ID: "br-young-lab", NEON_FUNCTION_HOST_SUFFIX: ".compute.c-2.us-east-2.aws.neon.tech" }),
  "https://br-young-lab-ingest.compute.c-2.us-east-2.aws.neon.tech",
  "neon env pull's branch id and host suffix build the ingest origin",
);
assert.equal(
  ingestBaseUrl({ NEON_FUNCTION_INGEST_BASE_URL: "https://old.example", NEON_BRANCH_ID: "br-young-lab", NEON_FUNCTION_HOST_SUFFIX: ".compute.example" }),
  "https://old.example",
  "an explicit base URL is not rebuilt from the suffix",
);
assert.throws(() => ingestBaseUrl({}), /NEON_FUNCTION_HOST_SUFFIX/, "neither form is an error that names what to set");

assert.deepEqual(await createLinearAdapter(() => undefined).ready(), [], "with no Linear key, ready work is an empty list and Linear is not called");

console.log("config regressions passed");
