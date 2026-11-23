import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { parseInventory, reportedHarnesses } from "@/lib/machine";
import { readRegistry } from "@/lib/repositories";
import type { NewJobDeps } from "@/lib/new-job";
import { defaultFilingSource, fileInto } from "@/lib/sources";

/** How the panel files a job: in the source the form picked, as the signed-in owner, with the harnesses the machines report and the registered repos. */
export const newJobDeps: NewJobDeps = {
  user: async () => (await auth.getSession()).data?.user,
  file: (draft) => fileInto(draft.source ?? defaultFilingSource(), draft),
  harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
  registry: () => readRegistry(db),
  machines: async () =>
    (await db.select({ id: machines.id, name: machines.name, inventory: machines.inventory }).from(machines)).map((machine) => ({
      id: machine.id,
      name: machine.name,
      executions: parseInventory(machine.inventory)?.executions,
    })),
};
