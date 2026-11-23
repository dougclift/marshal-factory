import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Harness } from "./harness";
import { fileNewJob, type NewJobDeps } from "./new-job";
import { matchMachine, type NamedMachine } from "./placement";
// An assistant files a queue job over HTTP. The shared ingest secret is the credential; the panel
// session is not. The route is /api/jobs/file, which the session proxy does not cover.

const bodySchema = z.object({
  title: z.string().trim().min(3, "Give the job a title of at least 3 characters.").max(200, "Keep the title under 200 characters."),
  description: z.string().trim().max(10_000, "Keep the description under 10,000 characters.").optional(),
  /** owner/name of an enabled target repo. Omitted files in the default repo. */
  repo: z.string().trim().min(1).optional(),
  /** A harness provider id, or its display name. */
  harness: z.string().trim().min(1).optional(),
  runsOn: z.enum(["mac", "modal"]).optional(),
  /** A machine id or display name. Pins the job to that machine and runs it locally. */
  machine: z.string().trim().min(1).optional(),
  /** Send the same id again to get the first job back instead of a second one. */
  requestId: z.uuid().optional(),
});

const RUNS_ON = { mac: "local", modal: "modal" } as const;

export type FileJobHttpDeps = {
  secret: string | undefined;
  registry: NewJobDeps["registry"];
  harnesses: NewJobDeps["harnesses"];
  machines: () => Promise<readonly NamedMachine[]>;
  file: NewJobDeps["file"];
};

/** Constant-time check of `Authorization: Bearer <secret>`. A missing secret never matches. */
export function bearerMatches(authorization: string | null, secret: string | undefined) {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function harnessId(harness: string, reported: readonly Harness[] | null) {
  return reported?.find((item) => item.enabled && (item.id === harness || item.name.toLowerCase() === harness.toLowerCase()))?.id;
}

export async function handleFileJob(request: Request, deps: FileJobHttpDeps): Promise<Response> {
  if (!bearerMatches(request.headers.get("authorization"), deps.secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const json = await request.json().catch(() => undefined);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "The job is not valid." }, { status: 400 });
  const { title, description, repo, harness, runsOn, machine, requestId } = parsed.data;
  if (machine && runsOn === "modal") {
    return Response.json({ error: "A machine runs the job locally. Leave runsOn off, or set it to mac." }, { status: 400 });
  }
  let provider: string | undefined;
  if (harness) {
    provider = harnessId(harness, await deps.harnesses());
    if (!provider) return Response.json({ error: `No machine reports an enabled harness ${harness}.` }, { status: 400 });
  }
  let targetMachine: string | undefined;
  if (machine) {
    const found = matchMachine(await deps.machines(), machine);
    if ("error" in found) return Response.json({ error: found.error }, { status: 400 });
    targetMachine = found.machine.id;
  }
  const outcome = await fileNewJob(
    { file: deps.file, harnesses: deps.harnesses, registry: deps.registry, machines: deps.machines },
    {
      title,
      description: description ?? "",
      requestId: requestId ?? randomUUID(),
      repo,
      provider,
      execution: targetMachine ? undefined : runsOn ? RUNS_ON[runsOn] : undefined,
      ...(targetMachine && { targetMachine }),
      source: "queue",
    },
  );
  if (!outcome.ok) return Response.json({ error: outcome.message }, { status: outcome.status });
  if (!outcome.id) return Response.json({ error: "the queue did not return a job id" }, { status: 502 });
  return Response.json({ key: outcome.identifier, id: outcome.id, url: outcome.url }, { status: 201 });
}
