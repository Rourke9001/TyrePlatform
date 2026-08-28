import "./capture.css";

// A plain anchor, not a router Link. This is the one navigation in the capture
// app where a full reload is the right thing: the draft is gone, the outbox
// wants a flush on app-open (FR-OFF-009), and the task list the driver is
// returning to has just changed on the server. It also keeps this screen
// renderable without a Router above it.
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
}: {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
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
        <p className="cap-done-body">
          It will send by itself when you have signal. You can close the app.
        </p>
        <BackToWork />
      </section>
    );
  }
  // FR-OFF-013: a supported recovery action, in plain language (NFR-USE-005).
  // TY003 is FR-INS-038's window and the one refusal a driver can resolve by
  // naming the vehicle to the office. Every other refusal is a different
  // conversation, so it gets the honest general answer rather than a specific
  // wrong one.
  return (
    <section className="cap-screen cap-done" role="alert">
      <p className="cap-done-mark cap-done-mark--stop" aria-hidden="true">
        !
      </p>
      <h1 className="cap-done-title">This one needs the office</h1>
      <p className="cap-done-body">
        {lastCode === "TY003"
          ? "This vehicle was already inspected a short while ago. Your readings are saved — call the tyre office and they can accept it."
          : "The office could not accept this inspection. Your readings are saved — call the tyre office."}
      </p>
      <BackToWork />
    </section>
  );
}
