import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { Harness } from "@/lib/harness";
import { JOB_IMAGE_TYPES, MAX_JOB_IMAGE_BYTES, newJobSchema, type ImageUploadOutcome, type NewJobOutcome } from "@/lib/new-job-schema";
import { defaultFilingSource, filingSources } from "@/lib/sources";
import type { FileDraft, FiledJob, ImageFile } from "@/lib/sources/types";
import { defaultRepo, repoLabel, REPOSITORY_GROUP, type Registry } from "@/lib/repositories";
import { matchMachine, runsLocal, type NamedMachine } from "@/lib/placement";
import { HARNESS_GROUP, RUNS_ON_GROUP, RUNS_ON_LABELS, runsOnMachineLabel } from "@/lib/ticket-overrides";

// A job started from the panel is filed in the source the form picked. Linear files a Todo issue
// with the factory label; the queue stores the same job in Postgres. Either way the runner claims
// it. A harness, place or repo chosen in the form is an override label, default or not.

export type NewJobDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  file: (draft: FileDraft) => Promise<FiledJob>;
  /** What the machines report; null when none has reported its harnesses yet. */
  harnesses: () => Promise<Harness[] | null>;
  registry: () => Promise<Registry>;
  /** The runners a job can be pinned to. Omitted, a pin is refused. */
  machines?: () => Promise<readonly NamedMachine[]>;
};

export async function fileNewJob(deps: Omit<NewJobDeps, "user">, input: unknown): Promise<NewJobOutcome> {
  const parsed = newJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The job is not valid." };
  const { provider, execution, targetMachine, repo, source: requested, ...draft } = parsed.data;
  const source = requested ?? defaultFilingSource();
  if (!filingSources().some((choice) => choice.source === source)) {
    return { ok: false, status: 400, message: source === "linear" ? "Linear is not configured." : `${source} is not a source the panel can file to.` };
  }
  const labels: NonNullable<FileDraft["labels"]> = [];
  const registry = await deps.registry();
  const target = repo ? registry.find((r) => r.repo === repo) : defaultRepo(registry);
  if (repo && !target?.enabled) return { ok: false, status: 400, message: `${repo} is not an enabled repository.` };
  if (target) labels.push({ group: REPOSITORY_GROUP, name: repoLabel(registry, target) });
  if (provider) {
    const harness = (await deps.harnesses())?.find((h) => h.id === provider && h.enabled);
    if (!harness) return { ok: false, status: 400, message: `No machine reports an enabled harness ${provider}.` };
    labels.push({ group: HARNESS_GROUP, name: harness.name });
  }
  let pinned: string | undefined;
  if (targetMachine) {
    const found = matchMachine(await deps.machines?.() ?? [], targetMachine);
    if ("error" in found) return { ok: false, status: 400, message: found.error };
    if (!runsLocal(found.machine)) return { ok: false, status: 400, message: `${found.machine.name} only runs Modal jobs, so a job can't be pinned to it.` };
    pinned = found.machine.id;
    labels.push({ group: RUNS_ON_GROUP, name: runsOnMachineLabel(found.machine) });
  } else if (execution) labels.push({ group: RUNS_ON_GROUP, name: RUNS_ON_LABELS[execution] });
  try {
    const filed = await deps.file({ ...draft, source, ...(pinned && { targetMachine: pinned }), ...(labels.length > 0 && { labels }) });
    return { ok: true, identifier: filed.key, url: filed.url, ...(filed.id ? { id: filed.id } : {}) };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not file the job: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function createJob(deps: NewJobDeps, input: unknown): Promise<NewJobOutcome> {
  if (!isOwner(await deps.user())) return { ok: false, status: 403, message: "Only the factory owner can start jobs." };
  return fileNewJob(deps, input);
}

export type ImageUploadDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  upload: (image: ImageFile) => Promise<string>;
};

/** Stores an image for a job the owner is about to file; the form puts the returned markdown in the description. */
export async function uploadJobImage(deps: ImageUploadDeps, file: File | null): Promise<ImageUploadOutcome> {
  if (!isOwner(await deps.user())) return { ok: false, status: 403, message: "Only the factory owner can add images." };
  if (!file) return { ok: false, status: 400, message: "No image was sent." };
  if (!(JOB_IMAGE_TYPES as readonly string[]).includes(file.type)) return { ok: false, status: 400, message: `${file.name} is not a PNG, JPEG, WebP or GIF image.` };
  if (file.size > MAX_JOB_IMAGE_BYTES) return { ok: false, status: 413, message: `${file.name} is larger than 4 MB.` };
  try {
    const markdown = await deps.upload({ filename: file.name, contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return { ok: true, markdown };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not upload ${file.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
