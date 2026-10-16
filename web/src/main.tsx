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
import { App } from "./App.tsx";

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
  renderFailure: (retry) => {
    root.render(
      <StrictMode>
        <ConfigFailure onRetry={retry} />
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
