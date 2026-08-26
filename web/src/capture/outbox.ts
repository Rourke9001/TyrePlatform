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
  // Diagnostics only, never rendered. A mapped SQLSTATE 422 can carry a raw
  // constraint name (reading_tyre_id_fkey is reachable: 000023 inserts
  // tyre_id with no pre-check), which no driver can act on. FR-OFF-013 asks
  // for a supported recovery action, not the server's reason.
  lastError: string | null;
}

// FR-OFF-012's ceiling. Thirty minutes, not "about half an hour": the
// requirement gives the number and the test asserts it exactly.
const MAX_BACKOFF_MS = 30 * 60 * 1000;
// Transport timing, not tenant policy: rule 5 governs thresholds a fleet
// operator sets — removal limits, pressure bands, alert multiples — and the
// capture context carries none that concern retry. FR-OFF-012 fixes the
// ceiling; this starting delay is an implementation choice beneath it.
const BASE_BACKOFF_MS = 5 * 1000;
// FR-OFF-020: approximately two days, when iOS eviction becomes a real risk.
const STALE_AFTER_MS = 48 * 3600 * 1000;

const table = () => db.table<OutboxEntry, string>("outbox");

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

// The distinction the whole outbox turns on. A permanent refusal will read the
// same in thirty minutes and in thirty hours, so retrying it burns the
// driver's battery and their airtime (NFR-CST-010) while hiding the fact that
// somebody has to act. 403 sits here too: an actor who may not capture will
// not acquire the capability by waiting. 401 deliberately does not: it is an
// expired session, recovered by signing in, and the queue then drains — that
// differs in kind from 403, whose actor gains nothing by waiting.
export function classify(error: unknown): "permanent" | "retryable" {
  if (error instanceof ApiError) {
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
  return table().toArray();
}

// One transaction. Between removing the draft and inserting the queue entry
// there must be no moment where a crash loses the inspection (FR-OFF-014).
export async function queueDraft(meta: SubmitMeta): Promise<OutboxEntry> {
  return db.transaction("rw", db.drafts, table(), async () => {
    const draft = await loadDraft();
    if (!draft) throw new Error("No inspection in progress.");

    // 000023 refuses an empty readings array (TY005 -> 422), which the
    // classifier reads as permanent — so queueing one would delete a draft
    // the driver can still finish and strand it in a queue that can never
    // drain. Left as a draft instead: FR-OFF-014, and SRS Appendix H's "no
    // submitted inspection may ever be lost".
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
      lastError: null,
    };
    await table().put(entry);
    // Through the module that owns the key, not a second copy of the string.
    // A draft this fails to delete is one the driver is handed back after it
    // has already been queued, and the next startDraft then refuses for good
    // (FR-OFF-014's "already in progress").
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
    // identically — the server has the inspection either way, which is the
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
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

// FR-OFF-009: on app-open and whenever connectivity returns while the app is
// open. Never Background Sync — iOS Safari does not have it and ADR-0009
// settled that this design does not depend on it.
export async function flushOutbox(opts: { force?: boolean } = {}): Promise<void> {
  for (const entry of await listOutbox()) {
    await attemptSend(entry.clientUuid, opts);
  }
}

// FR-OFF-012 says retry with backoff "while the app is open", and
// nextAttemptAt is only ever consulted by attemptSend — so without a
// heartbeat an entry that failed with a 500 while online would wait for a
// reload or a connectivity flap that may never come. The interval is the
// pulse, the backoff is the schedule; the two together are the requirement.
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
