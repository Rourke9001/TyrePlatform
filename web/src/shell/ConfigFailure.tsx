import "./shell.css";

// What a production build shows when it cannot read config.json: it sends
// nothing, and retries in place (ADR-0019, boot.ts). NFR-USE-005: say what
// to do, not only what failed. It renders outside ThemeProvider, on the
// token stylesheet main.tsx installs before boot, so Try again keeps
// NFR-USE-004's 44px floor from shell.css.
export function ConfigFailure({ onRetry, busy = false }: { onRetry: () => void; busy?: boolean }) {
  return (
    <div className="route-error" role="alert">
      <p>The app could not load its settings.</p>
      <p>Check your signal, then try again.</p>
      <p>Inspections already on this phone are kept.</p>
      {/* aria-disabled, not disabled (SignInButton.tsx says why); boot.ts
          ignores a tap while a retry is in flight. */}
      <button type="button" className="btn btn-secondary" aria-disabled={busy} onClick={onRetry}>
        {busy ? "Trying…" : "Try again"}
      </button>
    </div>
  );
}
