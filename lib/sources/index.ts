import type { JobRow } from "../../db/schema";
import { linear } from "./linear";
import { queue } from "./queue";
import { isRegisteredSource, jobId, SOURCE_SHAPES, type SourceShape } from "./shapes";
import type { FileDraft, FiledJob, ImageFile, Job, JobSource, LabelGroupSpec, SourceAdapter } from "./types";

export { jobId } from "./shapes";

// The runner, the panel and the ingest function reach a source only through its adapter, by the
// job's `source`. Adding a source is an adapter and a shape here; nothing outside lib/sources changes.

export const SOURCES: { [S in JobSource]: SourceAdapter<S> } = { linear, queue };

export const sourceFor = <S extends JobSource>(source: S): SourceAdapter<S> => {
  const adapter = SOURCES[source];
  if (!adapter) throw new Error(`no source adapter for ${source}`);
  return adapter;
};

export const isJobSource = (name: string): name is JobSource => Object.hasOwn(SOURCES, name);

/** Every registered source, for the work a runner does across them: claiming, stop checks, label sync. */
export const allSources = (): SourceAdapter<JobSource>[] => Object.values(SOURCES);

export type FilingChoice = { source: JobSource; label: string; isDefault: boolean };

/** Sources the panel and Slack can file into. Linear is offered only when the panel has its API key. */
export function filingSources(): FilingChoice[] {
  const linearOn = Boolean(process.env.LINEAR_API_KEY);
  const queued: FilingChoice = { source: "queue", label: SOURCE_SHAPES.queue.label, isDefault: !linearOn };
  return linearOn ? [{ source: "linear", label: SOURCE_SHAPES.linear.label, isDefault: true }, queued] : [queued];
}

/** Queue when Linear is not configured, otherwise Linear, so an existing factory keeps filing where it did. */
export function defaultFilingSource(): JobSource {
  return filingSources().find((choice) => choice.isDefault)!.source;
}

/** Where the panel files new jobs and uploads their images when the form does not name a source. */
export const panelSource = () => sourceFor(defaultFilingSource());

function filingAdapter(source: string) {
  if (!isJobSource(source) || !filingSources().some((choice) => choice.source === source)) {
    throw new Error(source === "linear" ? "LINEAR_API_KEY is not set, so the panel cannot file jobs in Linear" : `${source} is not a source the panel can file to`);
  }
  return sourceFor(source);
}

/** Files a draft in a source the panel is allowed to use. */
export function fileInto(source: string, draft: FileDraft): Promise<FiledJob> {
  const file = filingAdapter(source).file;
  if (!file) throw new Error(`${source} cannot file jobs`);
  return file(draft);
}

/** Stores an image for a job about to be filed in that source. */
export function uploadInto(source: string, image: ImageFile): Promise<string> {
  const upload = filingAdapter(source).uploadImage;
  if (!upload) throw new Error(`${source} cannot store images`);
  return upload(image);
}

/**
 * Adds Repository (and other) label groups in Linear when the panel has a key. With no key there
 * is nothing to add: queue jobs carry their labels on the row.
 */
export async function syncPanelLabels(groups: readonly LabelGroupSpec[]): Promise<{ created: string[]; problems: string[] }> {
  if (!process.env.LINEAR_API_KEY) return { created: [], problems: [] };
  const sync = sourceFor("linear").panelSyncLabelGroups;
  if (!sync) return { created: [], problems: [] };
  const result = await sync(groups);
  return { created: result.created, problems: result.problems };
}

/**
 * Adds a source beside the shipped ones. Only regressions call it, with a fake source that proves
 * the runner needs nothing source-specific; a real source is added to SOURCES and SOURCE_SHAPES.
 */
export function registerSource(shape: SourceShape, adapter: Omit<SourceAdapter<JobSource>, "source"> & { source: string }) {
  if (isRegisteredSource(adapter.source)) throw new Error(`source ${adapter.source} is registered already`);
  Object.assign(SOURCE_SHAPES, { [adapter.source]: shape });
  Object.assign(SOURCES, { [adapter.source]: adapter });
}

export function parseJob(row: JobRow): Job {
  if (!isJobSource(row.source)) throw new Error(`jobs row ${row.id} has unknown source ${row.source}`);
  const shapes = SOURCE_SHAPES[row.source];
  const id = jobId(row.source, row.external_id);
  if (row.id !== id) throw new Error(`jobs row ${row.id} should have id ${id}`);
  return {
    ...row,
    id,
    writeback: shapes.writeback.parse(row.writeback),
    source_state: shapes.sourceState.parse(row.source_state),
  };
}

export const parseJobs = (rows: readonly JobRow[]) => rows.map(parseJob);
