import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { loadRuntimeConfig } from "./api/runtimeConfig";
import { completeRedirect } from "./auth/callback";
import { ActorProvider } from "./auth/ActorProvider";
import { ThemeProvider } from "./theme/ThemeProvider";
import { boot } from "./shell/boot";
import { ConfigFailure } from "./shell/ConfigFailure";
import { installChunkReload } from "./shell/chunkReload";
import { installThemeStyle } from "./theme/themeStyle";
import { App } from "./App.tsx";

// First, so every screen boot() can render, ConfigFailure included, paints
// on the theme's tokens (ADR-0019 says why it is not an inline script).
installThemeStyle();

const queryClient = new QueryClient();

// Before the root renders, so a failed lazy chunk (TYRE-238) on the very
// first navigation is still covered.
installChunkReload();

const root = createRoot(document.getElementById("root")!);

// The redirect settles before the first render (callback.ts says why), and
// the configuration before the redirect (boot.ts).
void boot({
  loadConfig: loadRuntimeConfig,
  completeRedirect,
  render: () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <ActorProvider>
              <ThemeProvider>
                <App />
              </ThemeProvider>
            </ActorProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
  },
  renderFailure: (retry, busy) => {
    root.render(
      <StrictMode>
        <ConfigFailure onRetry={retry} busy={busy} />
      </StrictMode>,
    );
  },
  onOnline: (listener) => {
    window.addEventListener("online", listener);
    return () => {
      window.removeEventListener("online", listener);
    };
  },
});
