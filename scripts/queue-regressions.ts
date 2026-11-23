import "./test-guard";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const { fileNewJob } = await import("../lib/new-job");
const { bearerMatches, handleFileJob } = await import("../lib/job-file-http");
const { factoryLabel, planQueueResume, queue } = await import("../lib/sources/queue");
const { HARNESS_GROUP, RUNS_ON_GROUP } = await import("../lib/ticket-overrides");
const { REPOSITORY_GROUP } = await import("../lib/repositories");
const { db } = await import("../db/client");
const { intents, queueItems } = await import("../db/schema");
const { defaultFilingSource } = await import("../lib/sources");

const requestId = "6f0c3f8e-1f4b-4a52-9f0e-2d7c5a8b9c10";
const registry = async () => [
  { repo: "dougclift/shop", display_name: "Shop", enabled: true, is_default: true },
  { repo: "dougclift/api", display_name: null, enabled: true, is_default: false },
  { repo: "dougclift/old", display_name: null, enabled: false, is_default: false },
];
const harnesses = async () => [
  { id: "claude-1", driver: "claudeAgent", name: "Claude Code", enabled: true, models: [] },
  { id: "codex-off", driver: "codex", name: "Codex", enabled: false, models: [] },
];
type Draft = { source?: string; labels?: { group: string; name: string }[]; title: string; requestId: string };
const captured: Draft[] = [];
const file = async (draft: Draft) => {
  captured.push(draft);
  return { key: "MF-7", url: "https://panel.test/?job=MF-7", id: "queue:item-7" };
};
const deps = { file: file as never, harnesses, registry: registry as never };

{
  const saved = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    assert.equal(defaultFilingSource(), "queue", "with no Linear key the queue is the only filing source");
    captured.length = 0;
    const filed = await fileNewJob(deps, { title: "Show the count", description: "", requestId });
    assert.equal(filed.ok && filed.identifier, "MF-7");
    assert.equal(captured[0]!.source, "queue", "an omitted source files in the queue");
    process.env.LINEAR_API_KEY = "lin_test";
    captured.length = 0;
    await fileNewJob(deps, { title: "Show the count", description: "", requestId });
    assert.equal(captured[0]!.source, "linear", "with a key, an omitted source still files in Linear");
    captured.length = 0;
    await fileNewJob(deps, { title: "Show the count", description: "", requestId, source: "queue" });
    assert.equal(captured[0]!.source, "queue", "the form can file in the queue while Linear is configured");
    const refused = await fileNewJob(deps, { title: "Show the count", description: "", requestId, source: "nope" });
    assert.equal(!refused.ok && refused.status, 400);
  } finally {
    if (saved === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = saved;
  }
}

const secret = "ingest-secret";
const post = (body: unknown, authorization?: string) =>
  handleFileJob(new Request("https://panel.test/api/jobs/file", { method: "POST", headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }), { secret, file: file as never, harnesses, registry: registry as never, machines: async () => [] });

assert.equal(bearerMatches(null, undefined), false, "a missing secret never matches");
assert.equal(bearerMatches("Bearer ingest-secret", undefined), false);
assert.equal(bearerMatches("Bearer wrong", secret), false);
assert.equal(bearerMatches("Bearer ingest-secret", secret), true);
assert.equal(bearerMatches("Bearer ingest-secretx", secret), false, "a different length does not throw");

assert.equal((await post({ title: "Show the count" }, undefined)).status, 401, "no credential is refused");
assert.equal((await post({ title: "Show the count" }, "Bearer wrong")).status, 401, "the wrong secret is refused");
assert.equal((await handleFileJob(new Request("https://panel.test/api/jobs/file", { method: "POST", body: "{}" }), { secret: undefined, file: file as never, harnesses, registry: registry as never, machines: async () => [] })).status, 401, "an unset secret refuses every caller");

const bad = async (body: unknown, status: number) => assert.equal((await post(body, `Bearer ${secret}`)).status, status);
await bad({}, 400);
await bad({ title: "ab" }, 400);
await bad({ title: "Show the count", runsOn: "local" }, 400);
await bad({ title: "Show the count", repo: "dougclift/old" }, 400);
await bad({ title: "Show the count", repo: "dougclift/missing" }, 400);
await bad({ title: "Show the count", harness: "Codex" }, 400);

captured.length = 0;
const ok = await post({ title: "  Show the count  ", description: "On the button.", repo: "dougclift/api", harness: "Claude Code", runsOn: "mac", requestId }, `Bearer ${secret}`);
assert.equal(ok.status, 201);
assert.deepEqual(await ok.json(), { key: "MF-7", id: "queue:item-7", url: "https://panel.test/?job=MF-7" });
assert.equal(captured[0]!.source, "queue");
assert.equal(captured[0]!.title, "Show the count", "the title is trimmed");
assert.deepEqual(
  captured[0]!.labels,
  [
    { group: REPOSITORY_GROUP, name: "api" },
    { group: HARNESS_GROUP, name: "Claude Code" },
    { group: RUNS_ON_GROUP, name: "Local" },
  ],
  "a harness name and mac become the same override labels as the form",
);
captured.length = 0;
await post({ title: "Show the count", runsOn: "modal" }, `Bearer ${secret}`);
assert.deepEqual(captured.at(-1)!.labels, [
  { group: REPOSITORY_GROUP, name: "Shop" },
  { group: RUNS_ON_GROUP, name: "Cloud" },
], "an omitted repo uses the default, and modal is Cloud");

const waiting = {
  external_id: "item-1",
  stage_event_id: "event-1",
  question: "Which copy?",
  source_state: { state: "In Progress", labels: ["factory"], labelGroups: [], factoryCommentIds: ["ours"] },
  delivered_reply_ids: [] as string[],
};
assert.deepEqual(planQueueResume(waiting, { state: "Done", comments: [] }), { kind: "close", state: "Done" });
assert.deepEqual(planQueueResume({ ...waiting, stage_event_id: null }, { state: "In Progress", comments: [] }), { kind: "wait" });

{
  const saved = process.env.FACTORY_LABEL;
  process.env.FACTORY_LABEL = "factory";
  const id = randomUUID();
  let key = "";
  try {
    const filed = await queue.file!({ requestId: id, title: "Queue regression", description: "Filed with no Linear call." });
    key = filed.key;
    assert.match(filed.key, /^MF-\d+$/);
    assert.match(filed.id ?? "", /^queue:/);
    assert.match(filed.url, /\?job=MF-/);
    const again = await queue.file!({ requestId: id, title: "Queue regression", description: "Filed with no Linear call." });
    assert.equal(again.key, filed.key, "the same request files one job");
    const ready = await queue.ready();
    const draft = ready.find((item) => item.key === filed.key);
    assert.ok(draft, "the runner's ready list includes it");
    assert.deepEqual(draft!.sourceState.labels, ["factory"]);
    assert.equal(draft!.writeback.kind, "queue");
    const [intent] = await db.select().from(intents).where(eq(intents.id, `queue:claim:${id}`));
    assert.equal(intent?.kind, "claim", "filing wakes the runner with a claim intent");
  } finally {
    if (saved === undefined) delete process.env.FACTORY_LABEL;
    else process.env.FACTORY_LABEL = saved;
    if (key) {
      await db.delete(intents).where(eq(intents.id, `queue:claim:${id}`));
      await db.delete(queueItems).where(eq(queueItems.key, key));
    }
  }
  assert.equal(factoryLabel(), process.env.FACTORY_LABEL ?? "factory");
}

console.log("queue regressions passed");
