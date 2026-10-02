import { ACCESS_COPY } from "./actorContext";
import "./auth.css";

// No sign-in button on any of these, because signing in again cannot help
// (FR-TEN-009, ADR-0016). A reload is the retry, and it clears the store's
// latch.
export function AccessScreen({ failure }: { failure: keyof typeof ACCESS_COPY }) {
  const copy = ACCESS_COPY[failure];
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
