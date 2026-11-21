/**
 * The ingest Function's origin, with no trailing slash.
 *
 * `neon env pull` writes `NEON_BRANCH_ID` and `NEON_FUNCTION_HOST_SUFFIX`. A function slug
 * answers at `https://<branch id>-<slug><suffix>` (suffix like `.compute.c-2.us-east-2.aws.neon.tech`).
 * `NEON_FUNCTION_INGEST_BASE_URL`, which older pulls wrote, still wins when it is set.
 */
export function ingestBaseUrl(env: Record<string, string | undefined> = process.env, slug = "ingest"): string {
  const explicit = env.NEON_FUNCTION_INGEST_BASE_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const branch = env.NEON_BRANCH_ID;
  const suffix = env.NEON_FUNCTION_HOST_SUFFIX;
  if (branch && suffix) {
    const host = suffix.startsWith(".") ? suffix : `.${suffix}`;
    return `https://${branch}-${slug}${host}`;
  }
  throw new Error(
    "the ingest Function URL is not set: neon env pull writes NEON_BRANCH_ID and NEON_FUNCTION_HOST_SUFFIX, or set NEON_FUNCTION_INGEST_BASE_URL",
  );
}
