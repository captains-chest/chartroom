// Telling apart Home Assistant's websocket errors: what to show, and whether to try again.

/**
 * Home Assistant's answers that saving again can't change: the plan was refused as invalid, the
 * user is not an admin, the plan is gone, or the backend has no such command. Anything else (the connection lost,
 * a timeout, Chartroom reloading, an unexpected server error) may pass on a later try.
 */
const FINAL_ERRORS = new Set(['invalid_format', 'unauthorized', 'unknown_command', 'not_found']);

/** Whether a failed request might succeed if sent again. */
export function retryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return !(typeof code === 'string' && FINAL_ERRORS.has(code));
}

/**
 * A failed request's text. Home Assistant rejects with `{ code, message }`, or with the whole
 * `{ error: { code, message } }` result when the connection is lost mid-request.
 */
export function errorText(err: unknown): string {
  const e = err as { message?: unknown; error?: { message?: unknown } } | null;
  return String(e?.message ?? e?.error?.message ?? err);
}
