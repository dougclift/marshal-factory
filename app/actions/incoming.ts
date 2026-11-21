"use server";

import { addIncoming, discardIncoming, editIncoming, queueIncoming } from "@/lib/incoming";
import { incomingDeps } from "@/lib/incoming-deps";
import type { NewJob } from "@/lib/new-job-schema";

export async function addIncomingJob(input: NewJob) {
  return addIncoming(incomingDeps, input);
}

export async function editIncomingJob(input: NewJob) {
  return editIncoming(incomingDeps, input);
}

export async function queueIncomingJob(id: string) {
  return queueIncoming(incomingDeps, id);
}

export async function discardIncomingJob(id: string) {
  return discardIncoming(incomingDeps, id);
}
