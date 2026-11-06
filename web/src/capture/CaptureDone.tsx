import { Icon } from "../ui/Icon";
import { CheckIcon } from "../ui/icons/Check";
import { CriticalIcon } from "../ui/icons/Critical";
import { heldBy, SERVER_HOLD_COPY, STAMP_HOLD_COPY } from "./outbox";
import "./capture.css";

// Nothing sends while the app is closed (FR-OFF-009, ADR-0009), so the two
// lines that let the driver close it say the send waits for it to be open.
const SIGNAL_HOLD_DONE =
  "It sends by itself while the app is open with signal. You can close the app.";
const SERVER_HOLD_DONE =
  "The server could not take it yet. It sends by itself while the app is open. You can close the app.";

// A hold signal cannot clear says what clears it instead of promising a
// send (spec section 4, The indicator).
function waitingOn(lastStatus: number | null, lastCode: string | null, stampHeld: boolean): string {
  // U104: sendEntry records nothing when it refuses the stamp, so the status
  // cannot name this hold.
  if (stampHeld) return STAMP_HOLD_COPY;
  const held = heldBy(lastStatus, lastCode);
  // FR-OFF-006 keeps the entry across a restart. Signal and the server are
  // the two holds whose words ask nothing of the driver, so they alone add
  // that the driver may close the app.
  if (held === SERVER_HOLD_COPY) return SERVER_HOLD_DONE;
  return held ?? SIGNAL_HOLD_DONE;
}

// A plain anchor, not a router Link. Nothing on a screen that offers it needs
// keeping in memory, a full load flushes the outbox on app-open (FR-OFF-009),
// and the task list may have changed server-side. It also renders without a
// Router above it.
export function BackToWork() {
  return (
    <a className="cap-secondary" href="/my">
      My inspections
    </a>
  );
}

// NFR-USE-010's whole requirement: a driver cannot be expected to infer
// success from the absence of an error, so each of the three outcomes says
// what happened and what, if anything, is left to do.
export function CaptureDone({
  state,
  lastCode,
  lastStatus,
  stampHeld = false,
}: {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
  lastStatus: number | null;
  // True when the phone's subject may not carry the entry (mayCarry, U104).
  stampHeld?: boolean;
}) {
  if (state === "sent") {
    return (
      <section className="cap-screen cap-done" role="status">
        <p className="cap-done-mark cap-done-mark--ok" aria-hidden="true">
          <Icon icon={CheckIcon} size={48} />
        </p>
        <h1 className="cap-done-title">Inspection sent</h1>
        <p className="cap-done-body">The tyre office has it.</p>
        <BackToWork />
      </section>
    );
  }
  if (state === "queued") {
    // A success state, not an error. The driver's work is done and safe, and
    // implying otherwise is what makes people re-enter an inspection they
    // already completed.
    return (
      <section className="cap-screen cap-done" role="status">
        <p className="cap-done-mark cap-done-mark--ok" aria-hidden="true">
          <Icon icon={CheckIcon} size={48} />
        </p>
        <h1 className="cap-done-title">Inspection saved</h1>
        <p className="cap-done-body">{waitingOn(lastStatus, lastCode, stampHeld)}</p>
        <BackToWork />
      </section>
    );
  }
  // FR-OFF-013's recovery action, in plain language (NFR-USE-005). TY003 is
  // FR-INS-038's window, the one refusal a driver resolves by naming the
  // vehicle to the office; every other refusal gets the honest general
  // answer.
  return (
    <section className="cap-screen cap-done" role="alert">
      <p className="cap-done-mark cap-done-mark--stop" aria-hidden="true">
        <Icon icon={CriticalIcon} size={48} />
      </p>
      <h1 className="cap-done-title">This one needs the office</h1>
      <p className="cap-done-body">
        {lastCode === "TY003"
          ? "This vehicle was already inspected a short while ago. Your readings are saved. Call the tyre office and they can accept it."
          : "The office could not accept this inspection. Your readings are saved. Call the tyre office."}
      </p>
      <BackToWork />
    </section>
  );
}
