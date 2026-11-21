import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { IncomingJobRow } from "@/db/schema";
import { newJobSchema, type NewJobOutcome } from "@/lib/new-job-schema";

// Incoming holds jobs the owner wants on the board without the runner claiming them yet. A draft
// is the New job form's fields; sending it to Queued files it the way the form files a job, with
// the draft's id as the request id, so a retried send finds the job it filed the first time.

export type IncomingDraft = Omit<IncomingJobRow, "created_at" | "updated_at">;

export type IncomingOutcome = { ok: true; id: string } | { ok: false; status: 400 | 403 | 404 | 502; message: string };

export type IncomingDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  /** Creates the draft, or replaces its fields when a retried save already created it. */
  insert: (draft: IncomingDraft) => Promise<void>;
  /** Replaces the draft's fields; false when it is gone. */
  update: (draft: IncomingDraft) => Promise<boolean>;
  read: (id: string) => Promise<IncomingDraft | undefined>;
  remove: (id: string) => Promise<void>;
  /** Files a New job input; fileNewJob in the panel. */
  file: (input: unknown) => Promise<NewJobOutcome>;
};

const FORBIDDEN = { ok: false, status: 403, message: "Only the factory owner can change Incoming jobs." } as const;
const GONE = { ok: false, status: 404, message: "This job is no longer in Incoming." } as const;

function parse(input: unknown): IncomingOutcome | IncomingDraft {
  const parsed = newJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The job is not valid." };
  const { requestId, title, description, provider, execution, repo, source } = parsed.data;
  return { id: requestId, title, description, provider: provider ?? null, execution: execution ?? null, repo: repo ?? null, source: source ?? null };
}

/** Parks a new job in Incoming. */
export async function addIncoming(deps: IncomingDeps, input: unknown): Promise<IncomingOutcome> {
  if (!isOwner(await deps.user())) return FORBIDDEN;
  const draft = parse(input);
  if ("ok" in draft) return draft;
  await deps.insert(draft);
  return { ok: true, id: draft.id };
}

/** Saves the owner's edits to a job still in Incoming. */
export async function editIncoming(deps: IncomingDeps, input: unknown): Promise<IncomingOutcome> {
  if (!isOwner(await deps.user())) return FORBIDDEN;
  const draft = parse(input);
  if ("ok" in draft) return draft;
  return (await deps.update(draft)) ? { ok: true, id: draft.id } : GONE;
}

/** Files the job in its source, where the runner claims it from Queued, and takes it out of Incoming. */
export async function queueIncoming(deps: IncomingDeps, id: string): Promise<NewJobOutcome | typeof GONE> {
  if (!isOwner(await deps.user())) return FORBIDDEN;
  const draft = await deps.read(id);
  if (!draft) return GONE;
  const outcome = await deps.file({
    requestId: draft.id,
    title: draft.title,
    description: draft.description,
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.execution ? { execution: draft.execution } : {}),
    ...(draft.repo ? { repo: draft.repo } : {}),
    ...(draft.source ? { source: draft.source } : {}),
  });
  if (outcome.ok) await deps.remove(id);
  return outcome;
}

/** Drops a job from Incoming without filing it. */
export async function discardIncoming(deps: IncomingDeps, id: string): Promise<IncomingOutcome> {
  if (!isOwner(await deps.user())) return FORBIDDEN;
  await deps.remove(id);
  return { ok: true, id };
}
