import { useLayoutEffect } from "react";

import { deriveBrandTheme } from "../theme/derive";
import { applyCssVars, cssVars, palette } from "../theme/tokens";

// What a production build shows when it cannot read config.json: it sends
// nothing, and retries in place (ADR-0019, boot.ts). NFR-USE-005: say what
// to do, not only what failed.
export function ConfigFailure({ onRetry, busy = false }: { onRetry: () => void; busy?: boolean }) {
  // Outside ThemeProvider, the only other place the variables are set.
  // Without them .btn's min-height resolves to nothing and a gloved driver
  // loses NFR-USE-004's 44px floor.
  useLayoutEffect(() => {
    applyCssVars(document.documentElement, cssVars(deriveBrandTheme(palette.brand)));
  }, []);
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
