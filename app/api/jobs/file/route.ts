import { handleFileJob } from "@/lib/job-file-http";
import { newJobDeps } from "@/lib/new-job-deps";

/** Files a queue job. `Authorization: Bearer $FACTORY_INGEST_SECRET`. The session proxy does not cover this path. */
export async function POST(request: Request) {
  return handleFileJob(request, {
    secret: process.env.FACTORY_INGEST_SECRET,
    registry: newJobDeps.registry,
    harnesses: newJobDeps.harnesses,
    file: newJobDeps.file,
  });
}
