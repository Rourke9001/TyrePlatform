import { ApiError, apiPost } from "../api/client";
import { clearDraft, db, loadDraft } from "./draft";
import type { SubmitMeta, SubmitPayload } from "./payload";
import { toSubmitPayload } from "./payload";

export type OutboxState = "queued" | "sending" | "failed";

export interface OutboxEntry {
  clientUuid: string;
  state: OutboxState;
  payload: SubmitPayload;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastStatus: number | null;
  // The refusal's reason (ADR-0012); the status alone cannot separate
  // FR-INS-038's duplicate window from any other conflict. Null where the
  // refusal carried no envelope, or predates this field.
  lastCode: string | null;
  // Diagnostics only, never rendered: a mapped SQLSTATE 422 can carry a raw
  // constraint name no driver can act on (FR-OFF-013 wants a supported
  // recovery action, not the server's reason).
  lastError: string | null;
  // TYRE-167: the entry outlives the draft (queueDraft clears it), so the
  // vehicle on the cab, not a buried UUID, is what a driver recognises a
  // refused inspection by.
  fleetNumber: string | null;
}

// FR-OFF-012's ceiling. Thirty minutes, not "about half an hour": the
// requirement gives the number and the test asserts it exactly.
const MAX_BACKOFF_MS = 30 * 60 * 1000;
// Transport timing, not tenant policy (rule 5): the capture context carries
// no retry thresholds. FR-OFF-012 fixes the ceiling; this starting delay is
// beneath it.
const BASE_BACKOFF_MS = 5 * 1000;
// FR-OFF-020: approximately two days, when iOS eviction becomes a real risk.
const STALE_AFTER_MS = 48 * 3600 * 1000;

const table = () => db.table<OutboxEntry, string>("outbox");

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

// A permanent refusal reads the same in 30 minutes or 30 hours, so retrying
// burns battery/airtime (NFR-CST-010) while hiding that a person must act.
// 403 sits here (no capability gained by waiting); 401 does not (an
// expired session, recovered by signing in, drains the queue).
export function classify(error: unknown): "permanent" | "retryable" {
  if (error instanceof ApiError) {
    // TYRE-215: the future-skew refusal (TY021, 000041) is a 422 that time
    // cures: the same payload lands once the server clock passes the
    // stamped instant, so it is the one 422 that retries.
    if (error.code === "TY021") return "retryable";
    if ([400, 403, 409, 422].includes(error.status)) return "permanent";
    return "retryable";
  }
  // A TypeError from fetch is a dead network, which is the case this whole
  // design exists for.
  return "retryable";
}

export function isStale(entry: { queuedAt: number }, now: number = Date.now()): boolean {
  return now - entry.queuedAt >= STALE_AFTER_MS;
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const entries = await table().toArray();
  // TYRE-167: an entry written before fleetNumber existed has no such column
  // in its stored row, so Dexie hands it back as undefined, not null. One
  // normalisation here rather than an `?? null` at every consumer.
  return entries.map((e) => ({ ...e, fleetNumber: e.fleetNumber ?? null }));
}

// TYRE-167/FR-OFF-013: only a FAILED entry may go; queued and sending are
// the driver's work in flight, which FR-OFF-014 forbids dropping. The
// caller confirms (ConfirmDiscard).
export async function discardEntry(clientUuid: string): Promise<void> {
  await db.transaction("rw", table(), async () => {
    const entry = await table().get(clientUuid);
    if (!entry) return;
    if (entry.state !== "failed") {
      throw new Error(
        "Only an inspection the office has refused can be removed; this one is not refused.",
      );
    }
    await table().delete(clientUuid);
  });
}

// One transaction: no moment between removing the draft and inserting the
// queue entry where a crash loses the inspection (FR-OFF-014).
export async function queueDraft(meta: SubmitMeta): Promise<OutboxEntry> {
  return db.transaction("rw", db.drafts, table(), async () => {
    const draft = await loadDraft();
    if (!draft) throw new Error("No inspection in progress.");

    // 000023 refuses an empty readings array (TY005 -> 422, permanent), so
    // queueing one would strand a finishable draft; left as a draft
    // instead (FR-OFF-014, SRS Appendix H).
    const payload = toSubmitPayload(draft, meta);
    if (payload.readings.length === 0) {
      throw new Error("No completed positions to submit.");
    }

    const entry: OutboxEntry = {
      clientUuid: draft.clientUuid,
      state: "queued",
      payload,
      queuedAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      lastStatus: null,
      lastCode: null,
      lastError: null,
      fleetNumber: draft.fleetNumber ?? null,
    };
    await table().put(entry);
    // Through the module that owns the key, not a second copy of the string:
    // a draft this fails to delete leaves the next startDraft refusing for
    // good (FR-OFF-014's "already in progress").
    await clearDraft();
    return entry;
  });
}

export async function attemptSend(
  clientUuid: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const entry = await table().get(clientUuid);
  if (!entry) return;
  if (entry.state === "failed" && !opts.force) return;
  if (!opts.force && Date.now() < entry.nextAttemptAt) return;

  await table().update(clientUuid, { state: "sending" });
  try {
    // FR-OFF-011: 201 first time, 200 on replay, and the outbox treats them
    // identically. The server has the inspection either way, which is the
    // only question the queue is asking.
    await apiPost<{ inspectionId: string }>("/api/inspections", entry.payload);
    await table().delete(clientUuid);
  } catch (error) {
    const attempts = entry.attempts + 1;
    const permanent = classify(error) === "permanent";
    await table().update(clientUuid, {
      state: permanent ? "failed" : "queued",
      attempts,
      nextAttemptAt: permanent ? 0 : Date.now() + backoffMs(attempts),
      lastStatus: error instanceof ApiError ? error.status : null,
      lastCode: error instanceof ApiError ? error.code : null,
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

// FR-OFF-009: on app-open and whenever connectivity returns while the app is
// open. Never Background Sync. iOS Safari does not have it and ADR-0009
// settled that this design does not depend on it.
export async function flushOutbox(opts: { force?: boolean } = {}): Promise<void> {
  for (const entry of await listOutbox()) {
    await attemptSend(entry.clientUuid, opts);
  }
}

// FR-OFF-012's retry-with-backoff needs a pulse while the app is open;
// nextAttemptAt is only ever consulted by attemptSend, so without a
// heartbeat a failed entry waits for a reload that may never come.
export function startOutboxHeartbeat(
  // FR-OFF-012 requires that retries happen on a heartbeat while the app is
  // open, not any particular cadence. The interval is a parameter with a
  // default rather than a constant, so a caller can change it without this
  // becoming a second place to configure the schedule.
  everyMs = 30_000,
): () => void {
  const handle = window.setInterval(() => void flushOutbox(), everyMs);
  return () => window.clearInterval(handle);
}
