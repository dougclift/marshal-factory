import { incomingQuery, sealedResponse } from "@/lib/live-queries";

export async function POST() {
  return sealedResponse(incomingQuery());
}
