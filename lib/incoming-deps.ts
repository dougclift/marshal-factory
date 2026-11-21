import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { incomingJobs } from "@/db/schema";
import type { IncomingDeps } from "@/lib/incoming";
import { fileNewJob } from "@/lib/new-job";
import { newJobDeps } from "@/lib/new-job-deps";

/** Incoming drafts live in the panel's Postgres; sending one files it with the New job form's deps. */
export const incomingDeps: IncomingDeps = {
  user: newJobDeps.user,
  insert: async ({ id, ...fields }) => {
    const now = new Date();
    await db
      .insert(incomingJobs)
      .values({ id, ...fields, created_at: now, updated_at: now })
      .onConflictDoUpdate({ target: incomingJobs.id, set: { ...fields, updated_at: now } });
  },
  update: async ({ id, ...fields }) =>
    (await db.update(incomingJobs).set({ ...fields, updated_at: new Date() }).where(eq(incomingJobs.id, id)).returning({ id: incomingJobs.id })).length > 0,
  read: async (id) => {
    const [row] = await db.select().from(incomingJobs).where(eq(incomingJobs.id, id));
    return row;
  },
  remove: async (id) => {
    await db.delete(incomingJobs).where(eq(incomingJobs.id, id));
  },
  file: (input) => fileNewJob(newJobDeps, input),
};
