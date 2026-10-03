// status is the outbox's decision (FR-OFF-012 vs FR-OFF-013); code is the
// refusal reason a 409 alone cannot carry (FR-INS-038, ADR-0012); message is
// the envelope's text, or a diagnostic when absent (ADR-0013).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A query's retry rule. A 401 or 403 answers the same next time, so a
// signed-out driver is not kept waiting through the retries, and
// auth_unavailable is the token store's latch, which only a reload clears
// (spec section 4, Signing in).
export function retryQuery(failures: number, error: unknown): boolean {
  return (
    failures < 3 &&
    !(
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403 || error.code === "auth_unavailable")
    )
  );
}
