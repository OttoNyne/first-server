// Cloudinary answers 401/403 when the account itself refuses the action
// (e.g. `action is disabled for <cloud>`, a suspended or over-quota account,
// revoked keys) and 420 when it is rate limiting us. Retrying can't fix any of
// these, so they're reported as "storage is unavailable" (503) instead of the
// generic "try again" failure, and logged loudly so the operator notices.
export function isStorageUnavailable(err) {
  const code = Number(err?.http_code ?? err?.status);
  return code === 401 || code === 403 || code === 420;
}

export const STORAGE_UNAVAILABLE_MESSAGE = "File storage is temporarily unavailable — please try again later.";

export function logStorageProblem(where, err) {
  const detail = err?.message ?? err;
  if (isStorageUnavailable(err)) {
    console.error(`STORAGE UNAVAILABLE (${where}): Cloudinary refused the request — ${detail}. Uploads will fail until the Cloudinary account is fixed.`);
  } else {
    console.error(`Cloudinary ${where} failed:`, detail);
  }
}
