import "./test-guard";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs, machines } = await import("../db/schema");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { handleFileJob } = await import("../lib/job-file-http");
const { machineMayClaim, placementOf } = await import("../lib/placement");
const { NEW_JOB_BLOCKS, newJobInput, renderNewJobModal } = await import("../lib/slack-new-job");
const { ticketOverrides } = await import("../lib/ticket-overrides");
const { config } = await import("../runner/config");
const { claim, claimLaunch } = await import("../runner/ops");
const { linearJob } = await import("./fixtures");

const prefix = `target-${Date.now()}`;
const REPO = `${prefix}/demo`;
const VPS = `${prefix}-vps`;
const slot = (id: string) => ({ id, repos: [REPO], maxInFlight: 4 });
const local = { execution: "local" as const, ticket: null };
const modal = { execution: "modal" as const, ticket: null };
const savedExecutions = [...config.factory.executions];
const savedCap = config.factory.maxInFlight;

const mac = { id: "mac-1", name: "Doug's Mac" };
const linux = { id: VPS, name: "Linux box" };
const named = [mac, linux];

// A pin is local on that machine, ahead of Settings. A runner only claims a place it lists.
assert.deepEqual(placementOf({ execution: "modal" }, "mac-1", "modal"), { execution: "local", targetMachine: "mac-1" }, "a pin runs locally, ahead of a Modal label");
assert.equal(machineMayClaim(placementOf({}, null, "local"), "anywhere", ["local", "modal"]), true, "an untargeted local job stays claimable by any runner that runs local");
assert.equal(machineMayClaim(placementOf({ execution: "modal" }, null, "local"), VPS, ["local", "modal"]), true, "an untargeted Modal job is claimable by any runner");
assert.equal(machineMayClaim(placementOf({ targetMachine: "mac-1" }, null, "modal"), VPS, ["local", "modal"]), false, "another machine skips a pin");
assert.equal(machineMayClaim(placementOf({ targetMachine: "mac-1" }, null, "modal"), "mac-1", ["modal"]), false, "a Modal-only runner skips a pin, because a pin runs locally");
assert.equal(machineMayClaim(placementOf({}, null, "local"), VPS, ["modal"]), false, "a Modal-only runner skips a job Settings would run locally");
assert.equal(machineMayClaim(placementOf({ execution: "local" }, null, "modal"), VPS, ["modal"]), false, "a Modal-only runner skips a job a label sends to local");
assert.equal(machineMayClaim(placementOf({ execution: "modal" }, null, "local"), VPS, ["modal"]), true, "a Modal-only runner still claims Modal");

assert.deepEqual(ticketOverrides({ harness: [], runsOn: ["Local"], repository: [] }, null, named), { execution: "local", problems: [] }, "the Local label still means local");
assert.deepEqual(ticketOverrides({ harness: [], runsOn: ["Modal"], repository: [] }, null, named), { execution: "modal", problems: [] }, "the old Modal label still means the cloud");
assert.deepEqual(
  ticketOverrides({ harness: [], runsOn: ["Doug's Mac"], repository: [] }, null, named),
  { execution: "local", targetMachine: "mac-1", problems: [] },
  "a Runs on label names a machine by its display name",
);
assert.deepEqual(
  ticketOverrides({ harness: [], runsOn: [VPS], repository: [] }, null, named),
  { execution: "local", targetMachine: VPS, problems: [] },
  "a Runs on label names a machine by its id",
);
assert.match(ticketOverrides({ harness: [], runsOn: ["Sky"], repository: [] }, null, named).problems[0] ?? "", /neither Local nor Cloud/, "an unknown label still falls back to Settings");

const modalView = renderNewJobModal({ title: "", description: "" }, { registry: [], harnesses: [], sources: [], machines: named }, {});
const runsOn = modalView.blocks.find((block) => block.block_id === NEW_JOB_BLOCKS.runsOn);
assert.ok(runsOn && "element" in runsOn && runsOn.element && "options" in runsOn.element);
assert.deepEqual(
  runsOn.element.options?.map((option) => option.text.text),
  ["Settings default", "Local", "Cloud", "Doug's Mac", "Linux box"],
  "Slack lists Settings, the places, then each machine by name",
);
assert.deepEqual(newJobInput("V1", { [NEW_JOB_BLOCKS.runsOn]: { value: { selected_option: { value: "machine:mac-1" } } }, [NEW_JOB_BLOCKS.title]: { value: { value: "Pin it" } }, [NEW_JOB_BLOCKS.description]: { value: { value: "" } } }).targetMachine, "mac-1");

const secret = "ingest-secret";
const filed: { targetMachine?: string; labels?: { group: string; name: string }[]; execution?: string }[] = [];
const http = (body: unknown) =>
  handleFileJob(new Request("https://panel.test/api/jobs/file", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), {
    secret,
    file: (async (draft: { targetMachine?: string; labels?: { group: string; name: string }[] }) => {
      filed.push(draft);
      return { key: "MF-1", url: "https://panel.test/?job=MF-1", id: "queue:1" };
    }) as never,
    harnesses: async () => [],
    registry: async () => [],
    machines: async () => named,
  });
const errorOf = async (body: unknown) => ((await (await http(body)).json()) as { error: string }).error;

{
  filed.length = 0;
  const macJob = await http({ title: "Count the items", runsOn: "mac" });
  assert.equal(macJob.status, 201, "runsOn mac still files");
  assert.equal(filed[0]?.targetMachine, undefined, "and does not pin a machine");
  assert.deepEqual(filed[0]?.labels, [{ group: "Runs on", name: "Local" }]);

  filed.length = 0;
  assert.equal((await http({ title: "Count the items", runsOn: "modal" })).status, 201, "runsOn modal still files");
  assert.equal(filed[0]?.targetMachine, undefined);
  assert.deepEqual(filed[0]?.labels, [{ group: "Runs on", name: "Cloud" }]);

  filed.length = 0;
  assert.equal((await http({ title: "Count the items", machine: "Doug's Mac" })).status, 201, "a display name pins the job");
  assert.equal(filed[0]?.targetMachine, "mac-1");
  assert.deepEqual(filed[0]?.labels, [{ group: "Runs on", name: "Doug's Mac" }], "and the label is that machine, which implies local");

  filed.length = 0;
  assert.equal((await http({ title: "Count the items", machine: "MAC-1", runsOn: "mac" })).status, 201, "an id, with runsOn mac, pins the same machine");
  assert.equal(filed[0]?.targetMachine, "mac-1");

  assert.equal(await errorOf({ title: "Count the items", machine: "Nowhere" }), "No machine is named Nowhere.", "an unknown machine is a 400");
  assert.match(await errorOf({ title: "Count the items", machine: "Doug's Mac", runsOn: "modal" }), /runs the job locally/);
  const modalOnlyMachines = async () => [{ id: "vps-1", name: "Linux box", executions: ["modal" as const] }];
  const pinnedToModal = await handleFileJob(
    new Request("https://panel.test/api/jobs/file", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Count the items", machine: "Linux box" }) }),
    { secret, file: (async () => ({ key: "MF-1", url: "u", id: "queue:1" })) as never, harnesses: async () => [], registry: async () => [], machines: modalOnlyMachines },
  );
  assert.equal(pinnedToModal.status, 400);
  assert.match(((await pinnedToModal.json()) as { error: string }).error, /only runs Modal jobs/);
  const twins = async () => [...named, { id: "mac-2", name: "Doug's Mac" }];
  const ambiguous = await handleFileJob(
    new Request("https://panel.test/api/jobs/file", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Count the items", machine: "Doug's Mac" }) }),
    { secret, file: (async () => ({ key: "MF-1", url: "u", id: "queue:1" })) as never, harnesses: async () => [], registry: async () => [], machines: twins },
  );
  assert.equal(ambiguous.status, 400);
  assert.match(((await ambiguous.json()) as { error: string }).error, /More than one machine/);
}

const [existed] = await db.select({ id: machines.id }).from(machines).where(eq(machines.id, TEST_MACHINE_ID));
try {
  if (!existed) await db.insert(machines).values({ id: TEST_MACHINE_ID, name: "Doug's Mac", last_seen_at: new Date(), heartbeat: {} });
  await db.insert(machines).values({ id: VPS, name: "Linux box", last_seen_at: new Date(), heartbeat: {} });

  const pinned = `${prefix}-1`;
  const cloud = `${prefix}-2`;
  const anywhere = `${prefix}-3`;
  await db.insert(jobs).values([
    linearJob(pinned, pinned, { repo: REPO, target_machine: VPS }),
    linearJob(cloud, cloud, { repo: REPO }),
    linearJob(anywhere, anywhere, { repo: REPO }),
  ]);
  assert.equal(await claimLaunch(pinned, "pending:1", slot(TEST_MACHINE_ID), undefined, local), false, "a machine skips a job pinned to another");
  assert.equal(await claimLaunch(pinned, "pending:1", slot(VPS), undefined, modal), false, "and does not launch a pin in Modal");
  assert.equal(await claimLaunch(pinned, "pending:1", slot(VPS), undefined, local), true, "the machine it names claims it locally");
  assert.equal(await claimLaunch(cloud, "pending:1", slot(VPS), undefined, modal), true, "an untargeted Modal job is claimed by any runner");
  assert.equal(await claimLaunch(anywhere, "pending:1", slot(`${prefix}-other`), undefined, local), true, "an untargeted local job is still claimed by any local runner");

  config.factory.executions = ["modal"];
  const skipped = `${prefix}-4`;
  const taken = `${prefix}-5`;
  await db.insert(jobs).values([
    linearJob(skipped, skipped, { repo: REPO, target_machine: VPS }),
    linearJob(taken, taken, { repo: REPO }),
  ]);
  assert.equal(await claimLaunch(skipped, "pending:1", slot(VPS), undefined, local), false, "a Modal-only runner skips a job that would run locally, even one pinned to itself");
  assert.equal(await claimLaunch(taken, "pending:1", slot(VPS), undefined, modal), true, "and still claims a Modal job");
  config.factory.executions = savedExecutions;

  const label = (name: string) => ({ state: "Todo", labels: [name], labelGroups: [{ name, group: "Runs on" }] });
  const drafts = [
    { key: `${prefix}-6`, target: undefined, state: label("Linux box") },
    { key: `${prefix}-7`, target: undefined, state: label(TEST_MACHINE_ID) },
    { key: `${prefix}-8`, target: undefined, state: label("Cloud") },
    { key: `${prefix}-9`, target: undefined, state: label("Local") },
    { key: `${prefix}-10`, target: VPS, state: { state: "Todo", labels: [] } },
  ].map((draft) => ({
    externalId: draft.key,
    key: draft.key,
    title: draft.key,
    url: "u",
    description: null,
    targetMachine: draft.target,
    writeback: { kind: "linear" as const, issueId: draft.key },
    sourceState: draft.state,
  }));
  const source = {
    source: "linear" as const,
    ready: async () => drafts,
    overrides: (state: { labelGroups?: { name: string; group: string }[] }) => ({
      harness: [],
      runsOn: (state.labelGroups ?? []).filter((item) => item.group === "Runs on").map((item) => item.name),
      repository: [],
    }),
  };
  config.factory.executions = ["modal"];
  const modalOnly = await claim({ sources: [source as never], repos: async () => [REPO], registry: async () => [] });
  assert.deepEqual(modalOnly.claimed, [`${prefix}-8`], "a Modal-only runner adopts a Modal job and skips local ones, pins included");
  await db.delete(jobs).where(like(jobs.key, `${prefix}-%`));

  config.factory.executions = ["local", "modal"];
  const both = await claim({ sources: [source as never], repos: async () => [REPO], registry: async () => [] });
  assert.deepEqual(both.claimed.sort(), [`${prefix}-7`, `${prefix}-8`, `${prefix}-9`].sort(), "a runner that can do both adopts local, Modal and its own pin, and skips another machine's");

  // Local jobs already queued must not fill a Modal-only runner's slots.
  config.factory.executions = ["modal"];
  config.factory.maxInFlight = 2;
  await db.insert(jobs).values(
    [1, 2].map((n) =>
      linearJob(`${prefix}-held-${n}`, `${prefix}-2${n}`, {
        repo: REPO,
        source_state: { state: "Todo", labels: ["Local"], labelGroups: [{ name: "Local", group: "Runs on" }], factoryCommentIds: [] },
      }),
    ),
  );
  const room = await claim({
    sources: [{ source: "linear" as const, ready: async () => [{ externalId: `${prefix}-12`, key: `${prefix}-12`, title: "modal", url: "u", description: null, writeback: { kind: "linear" as const, issueId: `${prefix}-12` }, sourceState: label("Cloud") }], overrides: source.overrides }] as never,
    repos: async () => [REPO],
    registry: async () => [],
  });
  assert.deepEqual(room.claimed, [`${prefix}-12`], "queued local jobs do not use up a Modal-only runner's slots");
  const self = (await db.select({ target_machine: jobs.target_machine }).from(jobs).where(eq(jobs.key, `${prefix}-7`)))[0];
  assert.equal(self?.target_machine, TEST_MACHINE_ID, "the claim records the pin");
  const cloudRow = (await db.select({ target_machine: jobs.target_machine }).from(jobs).where(eq(jobs.key, `${prefix}-8`)))[0];
  assert.equal(cloudRow?.target_machine, null, "a Modal job stays unpinned");
} finally {
  config.factory.executions = savedExecutions;
  config.factory.maxInFlight = savedCap;
  await db.delete(jobs).where(like(jobs.key, `${prefix}-%`));
  await db.delete(machines).where(eq(machines.id, VPS));
  if (!existed) await db.delete(machines).where(eq(machines.id, TEST_MACHINE_ID));
}

console.log("target regressions passed");
