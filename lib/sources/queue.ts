import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { intents, jobs, queueComments, queueImages, queueItems, type QueueLabel } from "../../db/schema";
import { CONFIG_PATH, loadConfig } from "../config";
import type { Stage } from "../events";
import { attemptBranch, jobKey } from "../factory";
import { panelUrl } from "../slack";
import { inTestMode } from "../test-mode";
import { OVERRIDE_GROUPS, type SourceOverrides } from "../ticket-overrides";
import { jobId, type SourceStateDraftOf } from "./shapes";
import type { FileDraft, FiledJob, Job as AnyJob, Reply, ResumePlan, SourceAdapter } from "./types";
import { SourceGoneError } from "./types";
import { ATTACHMENTS_DIR } from "./linear";

type Db = NodePgDatabase<typeof schema>;
type Job = AnyJob<"queue">;
type Item = typeof queueItems.$inferSelect;

/** The key prefix for a job this source files. `jobKey("MF", 12)` is MF-12. */
const KEY_PREFIX = "MF";

const TODO = "Todo";
const IN_PROGRESS = "In Progress";
const IN_REVIEW = "In Review";
const DONE = "Done";
const CANCELED = "Canceled";
const FAILED_LABEL = "factory-failed";
const DELETED = "the queue job was deleted";
const CLOSED = new Set([DONE, CANCELED]);
const STARTED = new Set([IN_PROGRESS, IN_REVIEW]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The factory label this source offers and claims. The panel has no config file, so an explicit
 * FACTORY_LABEL wins; otherwise the runner's config, and `factory` when neither is there.
 */
export function factoryLabel(): string {
  if (process.env.FACTORY_LABEL) return process.env.FACTORY_LABEL;
  if (inTestMode() || existsSync(/* turbopackIgnore: true */ CONFIG_PATH)) return loadConfig().factory.label;
  return "factory";
}

/** A stable id, so a replay of the same filing or comment finds the first row. */
function stableId(...parts: string[]) {
  const hex = createHash("sha256").update(["marshal-factory", "queue", ...parts].join("\n")).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const claimCommentId = (itemId: string, attempt = 1) => (attempt > 1 ? stableId(itemId, "claim", String(attempt)) : stableId(itemId, "claim"));
const stageCommentId = (itemId: string, stageEventId: string) => stableId(itemId, stageEventId);
const resumeCommentId = (itemId: string, replyIds: readonly string[]) => stableId(itemId, "resume", ...replyIds);
const answerCommentId = (itemId: string, requestId: string) => stableId(itemId, "panel-answer", requestId);

const labeled = (labels: readonly QueueLabel[], name: string) => labels.some((label) => same(label.name, name));

export function queueOverrides(state: SourceStateDraftOf<"queue">): SourceOverrides {
  const inGroup = (group: string) => (state.labelGroups ?? []).filter((label) => same(label.group, group)).map((label) => label.name);
  return { harness: inGroup(OVERRIDE_GROUPS.harness), runsOn: inGroup(OVERRIDE_GROUPS.runsOn), repository: inGroup(OVERRIDE_GROUPS.repository) };
}

function applyLabels(labels: readonly QueueLabel[], change: { add?: readonly QueueLabel[]; remove?: readonly string[] }) {
  const drop = new Set((change.remove ?? []).map((name) => name.toLowerCase()));
  const next = labels.filter((label) => !drop.has(label.name.toLowerCase()));
  for (const add of change.add ?? []) {
    if (!next.some((label) => same(label.name, add.name) && (label.group ?? "") === (add.group ?? ""))) next.push(add);
  }
  return next;
}

function labelsFrom(draft: FileDraft, label: string): QueueLabel[] {
  return applyLabels(
    [],
    {
      add: [
        { name: label, group: null },
        ...(draft.labels ?? []).map((item) => ({ name: item.name, group: item.group })),
        ...(draft.tags ?? []).map((name) => ({ name, group: null })),
      ],
    },
  );
}

function draftOf(item: Item) {
  return {
    externalId: item.id,
    key: item.key,
    title: item.title,
    url: item.url,
    description: item.description,
    targetMachine: item.target_machine,
    writeback: { kind: "queue" as const, itemId: item.id },
    sourceState: {
      state: item.state,
      labels: item.labels.map((label) => label.name),
      labelGroups: item.labels.flatMap((label) => (label.group ? [{ name: label.name, group: label.group }] : [])),
    },
  };
}

/**
 * What a waiting queue job needs. Replies are comments after the question that the factory did
 * not post and no earlier resume delivered. Mirrors the Linear planner, on this source's rows.
 */
export function planQueueResume(job: Pick<Job, "external_id" | "stage_event_id" | "question" | "source_state" | "delivered_reply_ids">, view: { state: string; comments: readonly Reply[] }): ResumePlan {
  if (CLOSED.has(view.state)) return { kind: "close", state: view.state };
  if (!job.stage_event_id) return { kind: "wait" };
  const questionId = stageCommentId(job.external_id, job.stage_event_id);
  const asked = view.comments.find((comment) => comment.id === questionId);
  if (!asked) return { kind: "wait" };
  const ours = new Set([...job.source_state.factoryCommentIds, claimCommentId(job.external_id), questionId]);
  const delivered = new Set(job.delivered_reply_ids);
  const replies = view.comments
    .filter((comment) => comment.createdAt > asked.createdAt && !ours.has(comment.id) && !delivered.has(comment.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (replies.length === 0) return { kind: "wait" };
  return { kind: "resume", question: job.question ?? asked.body, replies, answer: replies.map((reply) => reply.body.trim()).join("\n\n") };
}

function stopReason(item: Item | undefined, label: string) {
  if (!item) return DELETED;
  if (CLOSED.has(item.state)) return `queue job moved to ${item.state}`;
  if (!labeled(item.labels, label)) return `the ${label} label was removed`;
  return undefined;
}

type WriteBack = {
  state?: string;
  labels?: { add?: QueueLabel[]; remove?: string[] };
  comment?: (job: Job) => string;
};

const writeBackTable = (label: string): Partial<Record<Stage, WriteBack>> => ({
  pr: {
    state: IN_REVIEW,
    comment: (job) =>
      [`marshal-factory has a pull request ready for review: ${job.pr_url}`, job.stage_summary ?? "", job.merge_assessment?.assumptions.length ? `**Assumptions I made**\n\n${job.merge_assessment.assumptions.map((assumption) => `- ${assumption}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
  },
  waiting: { comment: (job) => `marshal-factory stopped and needs an answer before it can continue:\n\n${job.question ?? job.stage_summary}` },
  failed: {
    state: TODO,
    labels: { add: [{ name: FAILED_LABEL, group: null }], remove: [label] },
    comment: (job) => `marshal-factory gave up on this job (attempt ${job.attempt}): ${job.stage_summary}\n\nRetry it from the inbox, or add the \`${label}\` label again.`,
  },
  merged: { state: DONE },
});

const commentIds = sql`coalesce(${jobs.source_state}->'factoryCommentIds', '[]'::jsonb)`;

async function database() {
  const { db } = await import("../../db/client");
  return db;
}

async function readItem(db: Pick<Db, "select">, id: string) {
  const [item] = await db.select().from(queueItems).where(eq(queueItems.id, id));
  return item;
}

async function mustItem(db: Db, id: string) {
  const item = await readItem(db, id);
  if (!item) throw new SourceGoneError(`queue item ${id} is gone`);
  return item;
}

/** Records the id before inserting, so a crash in between can never make our own comment look like a reply. */
async function postComment(db: Db, job: Job, id: string, body: string) {
  await db
    .update(jobs)
    .set({
      source_state: sql`jsonb_set(${jobs.source_state}, '{factoryCommentIds}', case when ${commentIds} ? ${id} then ${commentIds} else ${commentIds} || jsonb_build_array(${id}::text) end)`,
    })
    .where(eq(jobs.id, job.id));
  await db.insert(queueComments).values({ id, item_id: job.external_id, body, by_factory: true, created_at: new Date() }).onConflictDoNothing();
}

async function recordState(db: Db, job: Job, state: string) {
  await db.update(jobs).set({ source_state: sql`jsonb_set(${jobs.source_state}, '{state}', to_jsonb(${state}::text))` }).where(eq(jobs.id, job.id));
}

async function saveItem(db: Db, id: string, patch: { state?: string; labels?: QueueLabel[] }) {
  const [item] = await db.update(queueItems).set({ ...patch, updated_at: new Date() }).where(eq(queueItems.id, id)).returning();
  if (!item) throw new SourceGoneError(`queue item ${id} is gone`);
  return item;
}

async function saveLabels(db: Db, job: Job, labels: QueueLabel[]) {
  await saveItem(db, job.external_id, { labels });
  const names = JSON.stringify(labels.map((label) => label.name));
  const groups = JSON.stringify(labels.flatMap((label) => (label.group ? [{ name: label.name, group: label.group }] : [])));
  await db
    .update(jobs)
    .set({
      source_state: sql`jsonb_set(jsonb_set(${jobs.source_state}, '{labels}', ${names}::jsonb), '{labelGroups}', ${groups}::jsonb)`,
    })
    .where(eq(jobs.id, job.id));
}

async function wakeClaim(db: Db, itemId: string, intentId: string) {
  await db
    .insert(intents)
    .values({ id: intentId, kind: "claim", job_id: jobId("queue", itemId), created_at: new Date() })
    .onConflictDoNothing();
}

const isUnique = (error: unknown) => {
  const wrapped = error as { code?: string; cause?: { code?: string } };
  return wrapped.code === "23505" || wrapped.cause?.code === "23505";
};

function filed(item: Pick<Item, "id" | "key" | "url">): FiledJob {
  return { key: item.key, url: item.url, id: jobId("queue", item.id) };
}

const IMAGE = /!\[([^\]]*)\]\(queue-image:([0-9a-f-]{36})\)/g;
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

async function localize(job: { key: string }, text: string) {
  const ids = [...new Set([...text.matchAll(IMAGE)].map((match) => match[2]!))];
  if (ids.length === 0) return text;
  const db = await database();
  const rows = await db.select().from(queueImages).where(inArray(queueImages.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const dir = join(/* turbopackIgnore: true */ ATTACHMENTS_DIR, job.key);
  await mkdir(/* turbopackIgnore: true */ dir, { recursive: true });
  const saved = new Map<string, string>();
  for (const id of ids) {
    const row = byId.get(id);
    const ext = row ? IMAGE_EXT[row.content_type] : undefined;
    if (!row || !ext) continue;
    const path = join(/* turbopackIgnore: true */ dir, `${id}.${ext}`);
    await writeFile(/* turbopackIgnore: true */ path, row.bytes);
    saved.set(id, path);
  }
  const rewritten = text.replace(IMAGE, (whole, _alt: string, id: string) => {
    const path = saved.get(id);
    return path ? `[image: ${path}]` : `${whole} (the factory could not find this image)`;
  });
  if (saved.size === 0) return rewritten;
  return [rewritten, "", "## Images", "", `This text refers to ${saved.size === 1 ? "an image" : `${saved.size} images`}, saved on this machine. Open each one with the Read tool before you start; they are part of the spec.`, "", ...[...saved.values()].map((path) => `- ${path}`)].join("\n");
}

export function createQueueAdapter(): SourceAdapter<"queue"> {
  return {
    source: "queue",

    async ready() {
      const db = await database();
      const label = factoryLabel();
      const rows = await db.select().from(queueItems).where(eq(queueItems.state, TODO));
      return rows.filter((item) => labeled(item.labels, label)).map(draftOf);
    },

    async announceClaim(job) {
      if (job.source_state.state === IN_PROGRESS) return;
      const db = await database();
      const item = await mustItem(db, job.external_id);
      if (job.attempt > 1) await saveLabels(db, job, applyLabels(item.labels, { remove: [FAILED_LABEL] }));
      await saveItem(db, job.external_id, { state: IN_PROGRESS });
      await postComment(
        db,
        job,
        claimCommentId(job.external_id, job.attempt),
        job.attempt > 1 ? `Picked up by marshal-factory again (attempt ${job.attempt}, branch ${attemptBranch(job.key, job.attempt)}).` : "Picked up by marshal-factory.",
      );
      await recordState(db, job, IN_PROGRESS);
    },

    async writeBack(job, transition) {
      const action = writeBackTable(factoryLabel())[transition.stage];
      if (!action) return false;
      const db = await database();
      const item = await mustItem(db, job.external_id);
      if (action.labels) await saveLabels(db, job, applyLabels(item.labels, action.labels));
      if (action.state) {
        await saveItem(db, job.external_id, { state: action.state });
        await recordState(db, job, action.state);
      }
      if (action.comment) await postComment(db, job, stageCommentId(job.external_id, transition.eventId), action.comment(job));
      return true;
    },

    async replies(job) {
      const db = await database();
      const item = await mustItem(db, job.external_id);
      const comments = await db.select().from(queueComments).where(eq(queueComments.item_id, job.external_id)).orderBy(asc(queueComments.created_at));
      return planQueueResume(job, {
        state: item.state,
        comments: comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.created_at.toISOString() })),
      });
    },

    async acknowledgeReplies(job, replyIds) {
      await postComment(await database(), job, resumeCommentId(job.external_id, replyIds), "Answer received, resuming.");
    },

    async stopWanted(open) {
      if (open.length === 0) return [];
      const db = await database();
      const label = factoryLabel();
      const rows = await db.select().from(queueItems).where(inArray(queueItems.id, open.map((job) => job.external_id)));
      const byId = new Map(rows.map((item) => [item.id, item]));
      const wanted = [];
      for (const job of open) {
        const reason = stopReason(byId.get(job.external_id), label);
        if (reason) wanted.push({ job, reason });
      }
      return wanted;
    },

    async confirmStop(externalId, detail) {
      if (detail === DELETED) return { stop: true, reopen: false };
      const item = await readItem(await database(), externalId);
      if (!item) return { stop: true, reopen: false };
      if (labeled(item.labels, factoryLabel()) && !CLOSED.has(item.state)) return { stop: false };
      return { stop: true, reopen: STARTED.has(item.state) };
    },

    async note(job, key, body) {
      await postComment(await database(), job, stableId(job.external_id, "note", key), body);
    },

    overrides: queueOverrides,

    async labels(job) {
      return (await mustItem(await database(), job.external_id)).labels.map((label) => label.name);
    },

    async reopen(job) {
      const db = await database();
      await saveItem(db, job.external_id, { state: TODO });
      await recordState(db, job, TODO);
    },

    async requeue(job) {
      const db = await database();
      const item = await mustItem(db, job.external_id);
      const labels = applyLabels(item.labels, { add: [{ name: factoryLabel(), group: null }] });
      await saveItem(db, job.external_id, { state: TODO, labels });
      await wakeClaim(db, job.external_id, `queue:requeue:${job.id}:${job.attempt}`);
    },

    describe: (job) => `queue job ${job.key}`,

    /**
     * Files a Todo row with the factory label. The request id is the item id, so a retry returns
     * the first job. A claim intent wakes the runner; the timer would claim it anyway.
     */
    async file(draft) {
      const db = await database();
      const id = stableId("item", draft.requestId);
      const existing = await readItem(db, id);
      if (existing) return filed(existing);
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('marshal-factory queue-file'))`);
          const again = await readItem(tx, id);
          if (again) return filed(again);
          const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${queueItems.n}), 0)::int + 1` }).from(queueItems);
          const key = jobKey(KEY_PREFIX, Number(n));
          const now = new Date();
          const url = `${panelUrl()}/?job=${encodeURIComponent(key)}`;
          const description = draft.description.trim() ? draft.description : null;
          await tx.insert(queueItems).values({
            id,
            n: Number(n),
            key,
            request_id: draft.requestId,
            title: draft.title,
            description,
            state: TODO,
            labels: labelsFrom(draft, factoryLabel()),
            target_machine: draft.targetMachine ?? null,
            url,
            created_at: now,
            updated_at: now,
          });
          await tx.insert(intents).values({ id: `queue:claim:${draft.requestId}`, kind: "claim", job_id: jobId("queue", id), created_at: now }).onConflictDoNothing();
          return filed({ id, key, url });
        });
      } catch (error) {
        if (!isUnique(error)) throw error;
        const row = await readItem(db, id);
        if (row) return filed(row);
        throw error;
      }
    },

    /** Stores the owner's answer as a comment the factory did not write, so the runner reads it as a reply. */
    async reply(job, requestId, body) {
      await (await database()).insert(queueComments).values({ id: answerCommentId(job.external_id, requestId), item_id: job.external_id, body, by_factory: false, created_at: new Date() }).onConflictDoNothing();
    },

    async uploadImage(image) {
      const id = randomUUID();
      await (await database()).insert(queueImages).values({ id, filename: image.filename, content_type: image.contentType, bytes: Buffer.from(image.bytes), created_at: new Date() });
      const alt = image.filename.replace(/[[\]\n]/g, " ").trim() || "image";
      return `![${alt}](queue-image:${id})`;
    },

    localizeImages: localize,
  };
}

export const queue: SourceAdapter<"queue"> = createQueueAdapter();
