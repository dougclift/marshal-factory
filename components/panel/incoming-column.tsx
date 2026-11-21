"use client";

import { CloudIcon, ImageIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";
import type { IncomingJobRow } from "@/db/schema";
import { RUNS_ON_LABELS } from "@/lib/ticket-overrides";
import { IncomingJobDialog, type JobFormProps } from "./new-job-button";
import { ShortTime } from "./time";

const IMAGE = /!\[[^\]]*\]\([^)]+\)/g;

/** The board's first column: jobs parked before Queued. A card opens the job to edit it or send it on. */
export function IncomingColumn({
  jobs,
  repoLabels,
  ...form
}: JobFormProps & {
  jobs: readonly IncomingJobRow[];
  /** Each repo's short name, while more than one repo has jobs. */
  repoLabels?: ReadonlyMap<string, string>;
}) {
  // The row as it was opened, so the dialog keeps showing it after Send to Queued takes it off the feed.
  const [open, setOpen] = useState<IncomingJobRow | null>(null);
  const harnessName = (id: string) => form.harnesses.find((h) => h.id === id)?.name ?? id;
  return (
    <section data-stage="incoming" aria-label="Incoming" className="flex h-full w-80 shrink-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/72 px-3 font-medium">
        <span className="size-2 rounded-full border border-faint" />
        Incoming
        <span className="text-xs text-muted-foreground tabular-nums">{jobs.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-y-contain p-2">
        {jobs.length === 0 && <p className="px-1 text-xs text-faint">None</p>}
        {jobs.map((job) => {
          const images = job.description.match(IMAGE)?.length ?? 0;
          const repo = job.repo ? repoLabels?.get(job.repo) : undefined;
          return (
            <button
              key={job.id}
              type="button"
              data-card={job.id}
              aria-label={`Edit ${job.title}`}
              onClick={() => setOpen(job)}
              className="flex flex-col gap-1.5 rounded-lg border border-dashed bg-card p-2.5 text-left text-sm transition-colors hover:border-input"
            >
              <span className="line-clamp-2 font-medium leading-snug text-pretty">{job.title}</span>
              {job.description.replace(IMAGE, "").trim() && (
                <span className="line-clamp-2 text-xs text-muted-foreground">{job.description.replace(IMAGE, "").trim()}</span>
              )}
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShortTime date={job.updated_at} />
                {repo && <span className="min-w-0 truncate">{repo}</span>}
                <span className="ms-auto flex shrink-0 items-center gap-2">
                  {job.provider && <span>{harnessName(job.provider)}</span>}
                  {job.execution && (
                    <span title={RUNS_ON_LABELS[job.execution]}>
                      {job.execution === "modal" ? <CloudIcon className="size-3.5" aria-label={RUNS_ON_LABELS.modal} /> : <MonitorIcon className="size-3.5" aria-label={RUNS_ON_LABELS.local} />}
                    </span>
                  )}
                  {images > 0 && (
                    <span className="flex items-center gap-0.5" title={`${images} ${images === 1 ? "image" : "images"}`}>
                      <ImageIcon className="size-3.5" />
                      {images}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {open && <IncomingJobDialog key={open.id} job={open} onClose={() => setOpen(null)} {...form} />}
    </section>
  );
}
