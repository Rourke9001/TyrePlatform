import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { ActorProvider } from "./auth/ActorProvider";
import { ThemeProvider } from "./theme/ThemeProvider";
import { installChunkReload } from "./shell/chunkReload";
import { App } from "./App.tsx";

const queryClient = new QueryClient();

// Before the root renders, so a failed lazy chunk (TYRE-238) on the very
// first navigation is still covered.
installChunkReload();

createRoot(document.getElementById("root")!).render(
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
