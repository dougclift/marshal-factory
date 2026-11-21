import { auth } from "@/lib/auth/server";
import { uploadJobImage } from "@/lib/new-job";
import { defaultFilingSource, uploadInto } from "@/lib/sources";

/** A route, not a server action: server actions take 1 MB bodies, and a screenshot is often more. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("image");
  const source = form?.get("source");
  const outcome = await uploadJobImage(
    {
      user: async () => (await auth.getSession()).data?.user,
      upload: (image) => uploadInto(typeof source === "string" && source ? source : defaultFilingSource(), image),
    },
    file instanceof File ? file : null,
  );
  return Response.json(outcome, { status: outcome.ok ? 200 : outcome.status });
}
