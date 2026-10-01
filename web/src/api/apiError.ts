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
