import "./test-guard";
import assert from "node:assert/strict";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { addIncoming, discardIncoming, editIncoming, queueIncoming } = await import("../lib/incoming");
type Deps = Parameters<typeof addIncoming>[0];
type Draft = Parameters<Deps["insert"]>[0];

const owner = { email: OWNER, emailVerified: true };
const requestId = "9a1c2e4f-6b8d-4f0a-9c2e-4b6d8f0a2c4e";
const input = { title: "Add an Incoming step", description: "Before Queued.\n\n![shot](queue-image:1b2c3d4e-0000-4000-8000-000000000001)", requestId, source: "queue" };

function harness(user: { email: string; emailVerified: boolean } | null = owner) {
  const rows = new Map<string, Draft>();
  const filed: unknown[] = [];
  let failFiling = false;
  const deps: Deps = {
    user: async () => user,
    insert: async (draft) => void rows.set(draft.id, draft),
    update: async (draft) => rows.has(draft.id) && (rows.set(draft.id, draft), true),
    read: async (id) => rows.get(id),
    remove: async (id) => void rows.delete(id),
    file: async (job) => {
      if (failFiling) return { ok: false, status: 502, message: "Could not file the job: Linear is down" };
      filed.push(job);
      return { ok: true, identifier: "MF-9", url: "https://panel/?job=MF-9" };
    },
  };
  return { deps, rows, filed, failWith: (fail: boolean) => (failFiling = fail) };
}

{
  const { deps, rows, filed } = harness();
  assert.deepEqual(await addIncoming(deps, input), { ok: true, id: requestId }, "the owner parks a job in Incoming");
  assert.equal(filed.length, 0, "and nothing is filed, so the runner has nothing to claim");
  assert.deepEqual(rows.get(requestId), { id: requestId, title: input.title, description: input.description, provider: null, execution: null, target_machine: null, repo: null, source: "queue" }, "the draft keeps the form's fields");

  await addIncoming(deps, input);
  assert.equal(rows.size, 1, "a double submit keeps one draft");

  assert.equal((await addIncoming(deps, { ...input, title: "x" })).ok, false, "a title under 3 characters is refused");
}

{
  const { deps, rows, filed } = harness();
  await addIncoming(deps, input);
  const edited = { ...input, title: "Add an Incoming column", description: `${input.description}\n\nMore detail.`, provider: "claudeAgent", execution: "modal" };
  assert.deepEqual(await editIncoming(deps, edited), { ok: true, id: requestId }, "the owner edits the draft");
  assert.deepEqual(rows.get(requestId), { id: requestId, title: edited.title, description: edited.description, provider: "claudeAgent", execution: "modal", target_machine: null, repo: null, source: "queue" }, "title, description, harness and runs on change");

  const queued = await queueIncoming(deps, requestId);
  assert.deepEqual(queued, { ok: true, identifier: "MF-9", url: "https://panel/?job=MF-9" }, "sending it to Queued files it");
  assert.deepEqual(
    filed,
    [{ requestId, title: edited.title, description: edited.description, provider: "claudeAgent", execution: "modal", source: "queue" }],
    "with the edited fields, under the draft's id as the request id",
  );
  assert.equal(rows.has(requestId), false, "and it leaves Incoming");

  assert.equal((await queueIncoming(deps, requestId)).ok, false, "a second send finds nothing to file");
  assert.equal(filed.length, 1);
  const stale = await editIncoming(deps, edited);
  assert.deepEqual([stale.ok, !stale.ok && stale.status], [false, 404], "an edit from a dialog opened before the send does not bring it back");
  assert.equal(rows.size, 0);
}

{
  const { deps, rows, failWith } = harness();
  await addIncoming(deps, input);
  failWith(true);
  const down = await queueIncoming(deps, requestId);
  assert.equal(!down.ok && down.status, 502, "a filing failure is reported");
  assert.equal(rows.has(requestId), true, "and the job stays in Incoming to send again");
}

{
  const { deps, rows } = harness();
  await addIncoming(deps, input);
  assert.deepEqual(await discardIncoming(deps, requestId), { ok: true, id: requestId }, "the owner discards a draft");
  assert.equal(rows.size, 0);
}

{
  const ownerDeps = harness();
  await addIncoming(ownerDeps.deps, input);
  for (const user of [null, { email: "someone@example.com", emailVerified: true }]) {
    const { deps } = harness(user);
    const shared = { ...ownerDeps.deps, user: deps.user };
    for (const outcome of [await addIncoming(shared, input), await editIncoming(shared, input), await queueIncoming(shared, requestId), await discardIncoming(shared, requestId)]) {
      assert.deepEqual([outcome.ok, !outcome.ok && outcome.status], [false, 403], `${user?.email ?? "signed out"} cannot change Incoming`);
    }
  }
  assert.equal(ownerDeps.rows.size, 1, "and the draft is untouched");
  assert.equal(ownerDeps.filed.length, 0);
}

console.log("incoming regressions passed");
