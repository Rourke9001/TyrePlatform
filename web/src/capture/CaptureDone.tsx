import { ACCESS_COPY } from "../auth/actorContext";
import "./capture.css";

// A 401 waits for a sign-in. A latched store and a held 403 do not clear with
// signal, so they say what their access screen says instead of promising a
// send (spec section 4, The indicator).
function waitingOn(lastStatus: number | null, lastCode: string | null): string {
  if (lastStatus === 401) return "Sign in to send it.";
  if (lastCode === "auth_unavailable") return ACCESS_COPY.unavailable.body;
  if (lastCode === "tenant_inactive") return ACCESS_COPY["tenant-inactive"].body;
  if (lastCode === "not_provisioned") return ACCESS_COPY["not-set-up"].body;
  return "It will send by itself when you have signal. You can close the app.";
}

// A plain anchor, not a router Link: the draft is gone, the outbox wants a
// flush on app-open (FR-OFF-009), and the task list has just changed
// server-side. Also keeps this screen renderable without a Router above it.
function BackToWork() {
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
}: {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
  lastStatus: number | null;
}) {
  if (state === "sent") {
    return (
      <section className="cap-screen cap-done" role="status">
        <p className="cap-done-mark cap-done-mark--ok" aria-hidden="true">
          ✓
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
          ✓
        </p>
        <h1 className="cap-done-title">Inspection saved</h1>
        <p className="cap-done-body">{waitingOn(lastStatus, lastCode)}</p>
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
        !
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
