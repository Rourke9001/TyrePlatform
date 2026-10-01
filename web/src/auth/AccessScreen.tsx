import "./auth.css";

const COPY = {
  "not-set-up": {
    title: "Your account is not set up",
    body: "This account is not set up for a company yet. Contact your fleet office.",
  },
  // FR-TEN-009's explanatory message.
  "tenant-inactive": {
    title: "Your company's account is not active",
    body: "This company's account is not active. Contact your fleet office.",
  },
  unavailable: {
    title: "Sign-in is unavailable",
    body: "Sign-in is unavailable right now. Try again shortly.",
  },
} as const;

// No sign-in button on any of these: signing in again cannot help (FR-TEN-009,
// ADR-0016). A reload is the retry, and it clears the store's latch.
export function AccessScreen({ failure }: { failure: keyof typeof COPY }) {
  const copy = COPY[failure];
  return (
    <section className="auth-screen" aria-labelledby="access-heading">
      <h1 id="access-heading" className="auth-title">
        {copy.title}
      </h1>
      <p role="alert" className="auth-body">
        {copy.body}
      </p>
      {failure === "unavailable" && (
        <button type="button" className="auth-secondary" onClick={() => window.location.reload()}>
          Try again
        </button>
      )}
    </section>
  );
}
