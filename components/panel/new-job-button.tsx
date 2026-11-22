"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLinkIcon, ImagePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ClipboardEvent, type DragEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import { addIncomingJob, discardIncomingJob, editIncomingJob, queueIncomingJob } from "@/app/actions/incoming";
import { createJob } from "@/app/actions/new-job";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { EXECUTIONS, executionSchema } from "@/lib/execution";
import type { IncomingJobRow, RepoSettingsRow } from "@/db/schema";
import type { NamedMachine } from "@/lib/placement";
import type { Harness } from "@/lib/harness";
import { displayName } from "@/lib/repo-name";
import { RUNS_ON_LABELS } from "@/lib/ticket-overrides";
import { cn } from "@/lib/utils";
import { JOB_IMAGE_TYPES, MAX_JOB_IMAGE_BYTES, newJobSchema, type ImageUploadOutcome, type NewJob, type NewJobOutcome } from "@/lib/new-job-schema";

const blank = (source?: string): NewJob => ({ title: "", description: "", requestId: crypto.randomUUID(), ...(source ? { source } : {}) });

/** The form's values for a job in Incoming; its id is the request id it files under. */
const fromIncoming = (job: IncomingJobRow): NewJob => ({
  title: job.title,
  description: job.description,
  requestId: job.id,
  ...(job.provider ? { provider: job.provider } : {}),
  ...(job.execution ? { execution: job.execution } : {}),
  ...(job.target_machine ? { targetMachine: job.target_machine } : {}),
  ...(job.repo ? { repo: job.repo } : {}),
  ...(job.source ? { source: job.source } : {}),
});

export type FilingSource = { source: string; label: string; isDefault: boolean };

export type JobFormProps = {
  harnesses: readonly Harness[];
  repos: readonly Pick<RepoSettingsRow, "repo" | "display_name" | "enabled" | "is_default">[];
  sources: readonly FilingSource[];
  /** Runners a job can be pinned to, shown by display name. */
  machines: readonly NamedMachine[];
};

/** Where a new job lands: parked in Incoming for the owner to edit, or filed for the runner to claim. */
type Lands = "incoming" | "queued";
const landsItems: { value: Lands; label: string }[] = [
  { value: "incoming", label: "Incoming" },
  { value: "queued", label: "Queued" },
];

type JobImage = { id: string; name: string; preview: string } & (
  | { status: "uploading" }
  | { status: "done"; markdown: string }
  | { status: "failed"; message: string }
);

const imagesIn = (files: Iterable<File>) => [...files].filter((f) => f.type.startsWith("image/"));

async function uploadImage(file: File, source: string | undefined): Promise<ImageUploadOutcome> {
  if (!(JOB_IMAGE_TYPES as readonly string[]).includes(file.type)) return { ok: false, status: 400, message: "Only PNG, JPEG, WebP and GIF images." };
  if (file.size > MAX_JOB_IMAGE_BYTES) return { ok: false, status: 413, message: "Larger than 4 MB." };
  const body = new FormData();
  body.set("image", file);
  if (source) body.set("source", source);
  const res = await fetch("/api/jobs/images", { method: "POST", body }).catch(() => null);
  if (!res) return { ok: false, status: 502, message: "The upload did not reach the panel." };
  return (await res.json().catch(() => ({ ok: false, status: 502, message: `The panel answered ${res.status}.` }))) as ImageUploadOutcome;
}

const SETTINGS_DEFAULT = "settings-default";

const MACHINE_VALUE = "machine:";

const runsOnChoice = (execution: NewJob["execution"], targetMachine: string | undefined) =>
  targetMachine ? `${MACHINE_VALUE}${targetMachine}` : (execution ?? SETTINGS_DEFAULT);

/** Starts a job: parks it in Incoming, or files it in the source the form picks. The queue is always there; Linear is too when it is configured. */
export function NewJobButton(props: JobFormProps) {
  return <JobDialog {...props} />;
}

/** Edits a job in Incoming, discards it, or sends it to Queued by filing it. */
export function IncomingJobDialog({ job, onClose, ...props }: JobFormProps & { job: IncomingJobRow; onClose: () => void }) {
  return <JobDialog {...props} incoming={{ job, onClose }} />;
}

function JobDialog({ harnesses, repos, sources, machines, incoming }: JobFormProps & { incoming?: { job: IncomingJobRow; onClose: () => void } }) {
  const router = useRouter();
  const defaultSource = incoming ? (incoming.job.source ?? undefined) : (sources.find((source) => source.isDefault)?.source ?? sources[0]?.source);
  const initial = () => (incoming ? fromIncoming(incoming.job) : blank(defaultSource));
  const [open, setOpen] = useState(incoming !== undefined);
  const [created, setCreated] = useState<Extract<NewJobOutcome, { ok: true }> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<NewJob>({ resolver: zodResolver(newJobSchema), defaultValues: initial() });
  const [source, setSource] = useState<string | undefined>(defaultSource);
  const [lands, setLands] = useState<Lands>("incoming");
  const [images, setImages] = useState<JobImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const repoItems = repos.filter((r) => r.enabled).map((r) => ({ value: r.repo, label: displayName(r) }));
  const defaultRepo = repos.find((r) => r.is_default)?.repo ?? null;
  const harnessItems = [{ value: SETTINGS_DEFAULT, label: "Settings default" }, ...harnesses.map((h) => ({ value: h.id, label: h.name }))];
  const [runsOn, setRunsOnValue] = useState(() => runsOnChoice(form.getValues("execution"), form.getValues("targetMachine")));
  const chosenTarget = runsOn.startsWith(MACHINE_VALUE) ? runsOn.slice(MACHINE_VALUE.length) : undefined;
  const runsOnItems = [
    { value: SETTINGS_DEFAULT, label: "Settings default" },
    ...EXECUTIONS.map((e) => ({ value: e, label: RUNS_ON_LABELS[e] })),
    ...machines.map((machine) => ({ value: `${MACHINE_VALUE}${machine.id}`, label: machine.name })),
    ...(chosenTarget && !machines.some((machine) => machine.id === chosenTarget)
      ? [{ value: `${MACHINE_VALUE}${chosenTarget}`, label: chosenTarget }]
      : []),
  ];
  const setRunsOn = (value: string | null) => {
    const next = value ?? SETTINGS_DEFAULT;
    setRunsOnValue(next);
    if (next === SETTINGS_DEFAULT) {
      form.setValue("execution", undefined);
      form.setValue("targetMachine", undefined);
      return;
    }
    if (next.startsWith(MACHINE_VALUE)) {
      form.setValue("execution", undefined);
      form.setValue("targetMachine", next.slice(MACHINE_VALUE.length));
      return;
    }
    form.setValue("execution", executionSchema.parse(next));
    form.setValue("targetMachine", undefined);
  };
  const picker = useRef<HTMLInputElement>(null);
  const uploading = images.some((i) => i.status === "uploading");

  const reset = () => {
    const next = initial();
    form.reset(next);
    setRunsOnValue(runsOnChoice(next.execution, next.targetMachine));
    setSource(defaultSource);
    setLands("incoming");
    setCreated(null);
    setFailure(null);
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.preview);
      return [];
    });
  };

  // Each image is stored for the source selected now; its markdown joins the description.
  const addImages = (files: File[]) => {
    const draft = form.getValues("requestId");
    for (const file of files) {
      const id = crypto.randomUUID();
      setImages((current) => [...current, { id, name: file.name, preview: URL.createObjectURL(file), status: "uploading" }]);
      void uploadImage(file, source).then((outcome) => {
        // The dialog was closed or the source changed while this uploaded; the image belongs to a draft that is gone.
        if (form.getValues("requestId") !== draft || form.getValues("source") !== source) return;
        if (outcome.ok) {
          const description = form.getValues("description").trimEnd();
          form.setValue("description", description ? `${description}\n\n${outcome.markdown}` : outcome.markdown, { shouldValidate: true });
        }
        setImages((current) =>
          current.map((image) =>
            image.id !== id ? image : outcome.ok ? { ...image, status: "done", markdown: outcome.markdown } : { ...image, status: "failed", message: outcome.message },
          ),
        );
      });
    }
  };
  const removeImage = (image: JobImage) => {
    if (image.status === "done") {
      const description = form.getValues("description").replace(image.markdown, "").replace(/\n{3,}/g, "\n\n").trim();
      form.setValue("description", description, { shouldValidate: true });
    }
    URL.revokeObjectURL(image.preview);
    setImages((current) => current.filter((i) => i.id !== image.id));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imagesIn(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    setDragging(false);
    const files = imagesIn(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
  };
  const close = () => {
    setOpen(false);
    incoming?.onClose();
  };
  // Without live updates the board shows Incoming as the server last rendered it.
  const settle = (outcome: { ok: true } | { ok: false; message: string }, then: () => void) => {
    if (!outcome.ok) return setFailure(outcome.message);
    router.refresh();
    then();
  };
  // The select is the source of truth, so a switch from Modal to a machine never files both.
  const placed = (values: NewJob): NewJob => {
    if (runsOn.startsWith(MACHINE_VALUE)) return { ...values, execution: undefined, targetMachine: runsOn.slice(MACHINE_VALUE.length) };
    if (runsOn === "local" || runsOn === "modal") return { ...values, execution: runsOn, targetMachine: undefined };
    return { ...values, execution: undefined, targetMachine: undefined };
  };
  const submit = form.handleSubmit((values) => {
    setFailure(null);
    const job = placed(values);
    startTransition(async () => {
      if (incoming) settle(await editIncomingJob(job), close);
      else if (lands === "incoming") settle(await addIncomingJob(job), close);
      else {
        const outcome = await createJob(job);
        if (outcome.ok) setCreated(outcome);
        else setFailure(outcome.message);
      }
    });
  });
  // Saves the edits first, so what is filed is what the form shows.
  const sendToQueued = form.handleSubmit((values) => {
    if (!incoming) return;
    setFailure(null);
    const job = placed(values);
    startTransition(async () => {
      const saved = await editIncomingJob(job);
      if (!saved.ok) return setFailure(saved.message);
      const outcome = await queueIncomingJob(incoming.job.id);
      settle(outcome, () => outcome.ok && setCreated(outcome));
    });
  });
  const discard = () => {
    if (!incoming) return;
    setFailure(null);
    startTransition(async () => settle(await discardIncomingJob(incoming.job.id), close));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) return close();
        setOpen(next);
        reset();
      }}
    >
      {!incoming && (
        <DialogTrigger render={<Button size="sm" />}>
          <PlusIcon data-icon="inline-start" />
          New job
        </DialogTrigger>
      )}
      <DialogPopup className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.identifier} is filed</DialogTitle>
              <DialogDescription>
                The factory picks it up within a few seconds and it appears on the board in Queued.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" render={<a href={created.url} target="_blank" rel="noreferrer" />}>
                {source === "linear" ? "Open in Linear" : "Open the board"}
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
              {incoming ? <Button onClick={close}>Done</Button> : <Button onClick={reset}>Start another</Button>}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{incoming ? "Incoming job" : "New job"}</DialogTitle>
              <DialogDescription>
                {incoming
                  ? "Edit it until it is ready. Send to Queued files it, and the factory picks it up like any other job."
                  : lands === "incoming"
                    ? "Parks the job in Incoming on the board. The factory leaves it alone until you open it and send it to Queued."
                    : source === "linear"
                  ? "Files a Linear issue with the factory label. Questions and answers then happen on that issue. A harness or place other than the Settings default goes on the issue as its Harness or Runs on label."
                  : "Files a job in the factory queue. The runner picks it up like any other job. A harness or place other than the Settings default is stored on the job."}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="contents">
              <DialogPanel className="flex flex-col gap-5">
                {!incoming && (
                  <Field>
                    <FieldLabel htmlFor="new-job-lands">Lands in</FieldLabel>
                    <Select items={landsItems} value={lands} onValueChange={(value) => value && setLands(value)}>
                      <SelectTrigger id="new-job-lands" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {landsItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <FieldDescription>Incoming waits for you to edit and send it. Queued goes to the factory now.</FieldDescription>
                  </Field>
                )}
                {!incoming && sources.length > 1 && (
                  <Controller
                    name="source"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="new-job-source">File in</FieldLabel>
                        <Select
                          items={sources.map((source) => ({ value: source.source, label: source.label }))}
                          value={field.value ?? defaultSource}
                          onValueChange={(value) => {
                            if (value && value !== field.value && images.length > 0) {
                              const description = images.reduce(
                                (text, image) => (image.status === "done" ? text.replace(image.markdown, "") : text),
                                form.getValues("description"),
                              );
                              form.setValue("description", description.replace(/\n{3,}/g, "\n\n").trim(), { shouldValidate: true });
                              setImages((current) => {
                                for (const image of current) URL.revokeObjectURL(image.preview);
                                return [];
                              });
                            }
                            const next = value ?? undefined;
                            setSource(next);
                            field.onChange(next);
                          }}
                        >
                          <SelectTrigger id="new-job-source" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {sources.map((source) => (
                              <SelectItem key={source.source} value={source.source}>
                                {source.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <FieldDescription>Linear files an issue. Queue stores the job in the factory database.</FieldDescription>
                      </Field>
                    )}
                  />
                )}
                <Controller
                  name="title"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="new-job-title">Title</FieldLabel>
                      <Input {...field} id="new-job-title" aria-invalid={fieldState.invalid} placeholder="Show the item count on the weight sort button" autoFocus />
                      {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                    </Field>
                  )}
                />
                <Controller
                  name="description"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="new-job-description">Description</FieldLabel>
                      <Textarea
                        {...field}
                        id="new-job-description"
                        aria-invalid={fieldState.invalid}
                        rows={6}
                        placeholder="What should change, and how will you know it works?"
                        className={cn(dragging && "border-primary ring-1 ring-primary")}
                        onPaste={onPaste}
                        onDragOver={(event) => {
                          if (!event.dataTransfer.types.includes("Files")) return;
                          event.preventDefault();
                          setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={onDrop}
                      />
                      <FieldDescription>The agent reads this as the spec. Markdown works; paste or drop screenshots in.</FieldDescription>
                      {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                    </Field>
                  )}
                />
                {repoItems.length > 0 && (
                  <Controller
                    name="repo"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="new-job-repo">Repository</FieldLabel>
                        <Select items={repoItems} value={field.value ?? defaultRepo} onValueChange={(v) => field.onChange(v ?? undefined)}>
                          <SelectTrigger id="new-job-repo" className="w-full">
                            <SelectValue placeholder="Pick a repository" />
                          </SelectTrigger>
                          <SelectPopup>
                            {repoItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                                <span className="font-mono text-xs text-muted-foreground">{item.value}</span>
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <FieldDescription>Goes on the issue as its Repository label, the default one included.</FieldDescription>
                      </Field>
                    )}
                  />
                )}
                <div className="grid grid-cols-2 gap-4">
                  <Controller
                    name="provider"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="new-job-harness">Harness</FieldLabel>
                        <Select
                          items={harnessItems}
                          value={field.value ?? SETTINGS_DEFAULT}
                          onValueChange={(v) => field.onChange(v === null || v === SETTINGS_DEFAULT ? undefined : v)}
                        >
                          <SelectTrigger id="new-job-harness" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {harnessItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </Field>
                    )}
                  />
                  <Field>
                    <FieldLabel htmlFor="new-job-runs-on">Runs on</FieldLabel>
                    <Select items={runsOnItems} value={runsOn} onValueChange={setRunsOn}>
                      <SelectTrigger id="new-job-runs-on" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {runsOnItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {form.formState.errors.targetMachine && <FieldError>{form.formState.errors.targetMachine.message}</FieldError>}
                  </Field>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {images.map((image) => (
                    <div key={image.id} className="flex flex-col gap-1">
                      <div className={cn("relative size-16 overflow-hidden rounded-md border", image.status === "failed" && "border-destructive")}>
                        {/* A local preview of a file the owner just picked; next/image has nothing to optimize here. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.preview} alt={image.name} className={cn("size-full object-cover", image.status === "uploading" && "opacity-50")} />
                        {image.status === "uploading" && <Spinner className="absolute inset-0 m-auto" />}
                        {image.status !== "uploading" && (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="secondary"
                            className="absolute top-0.5 right-0.5"
                            aria-label={`Remove ${image.name}`}
                            onClick={() => removeImage(image)}
                          >
                            <XIcon />
                          </Button>
                        )}
                      </div>
                      {image.status === "failed" && <span className="max-w-16 text-xs text-destructive">{image.message}</span>}
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={() => picker.current?.click()}>
                    <ImagePlusIcon data-icon="inline-start" />
                    Add image
                  </Button>
                  <input
                    ref={picker}
                    type="file"
                    accept={JOB_IMAGE_TYPES.join(",")}
                    multiple
                    hidden
                    onChange={(event) => {
                      addImages(imagesIn(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                </div>
                {failure && (
                  <p role="alert" className="text-sm text-destructive">
                    {failure}
                  </p>
                )}
              </DialogPanel>
              <DialogFooter>
                {incoming && (
                  <Button type="button" variant="destructive-outline" className="sm:me-auto" disabled={pending} onClick={discard}>
                    Discard
                  </Button>
                )}
                <DialogClose disabled={pending} render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button type="submit" variant={incoming ? "outline" : "default"} disabled={pending || uploading}>
                  {(pending || uploading) && !incoming && <Spinner data-icon="inline-start" />}
                  {uploading ? "Uploading images" : incoming ? "Save" : lands === "incoming" ? "Add to Incoming" : "File job"}
                </Button>
                {incoming && (
                  <Button type="button" disabled={pending || uploading} onClick={sendToQueued}>
                    {(pending || uploading) && <Spinner data-icon="inline-start" />}
                    Send to Queued
                  </Button>
                )}
              </DialogFooter>
            </form>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
