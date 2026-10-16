// The API origin, read at startup from the web origin's /config.json, so one
// bundle serves every environment (ADR-0019, ADR-0017). Section 3 of
// docs/superpowers/specs/2026-10-16-platform-readiness-design.md.

import { REQUEST_TIMEOUT_SECONDS } from "./token";

// Not an ApiError, so the outbox classifies a send that hits it as
// retryable and keeps the inspection queued (outbox.ts, classify).
export class RuntimeConfigError extends Error {}

export function parseApiOrigin(body: unknown): string {
  const value =
    typeof body === "object" && body !== null && "apiOrigin" in body ? body.apiOrigin : undefined;
  if (typeof value !== "string") {
    throw new RuntimeConfigError("config.json names no apiOrigin");
  }
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new RuntimeConfigError("config.json's apiOrigin is not a URL");
  }
  if (origin !== value) {
    throw new RuntimeConfigError("config.json's apiOrigin must be an origin alone");
  }
  return value;
}

export interface RuntimeConfig {
  load(): Promise<void>;
  apiUrl(path: string): string;
}

export function createRuntimeConfig(
  dev: boolean,
  fetchFn: (input: string, init: RequestInit) => Promise<Response>,
): RuntimeConfig {
  // A dev build never fetches: no deploy writes the file there, and vite
  // dev's fallback would answer it with index.html. Paths stay relative, for
  // the Vite proxy, vitest and every e2e project.
  let origin: string | null = dev ? "" : null;
  return {
    async load() {
      if (origin !== null) return;
      // Bounded, or a stalled depot connection leaves a driver on "Loading."
      // with no way out. The signal is held until the body is parsed: a
      // bound that ends with the headers does not cover a stalled body
      // (docs/lessons.md, 2026-10-02).
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_SECONDS * 1000);
      try {
        // The default cache mode, so this consumes index.html's preload;
        // freshness is the server's Cache-Control: no-cache on the file.
        const res = await fetchFn("/config.json", { signal: controller.signal });
        if (!res.ok) throw new RuntimeConfigError(`config.json answered ${res.status}`);
        origin = parseApiOrigin(await res.json());
      } catch (error) {
        if (error instanceof RuntimeConfigError) throw error;
        throw new RuntimeConfigError("config.json could not be read", { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
    apiUrl(path) {
      if (origin === null) throw new RuntimeConfigError("the API origin is not loaded yet");
      return origin + path;
    },
  };
}

const runtime = createRuntimeConfig(import.meta.env.DEV, (input, init) => fetch(input, init));

export function loadRuntimeConfig(): Promise<void> {
  return runtime.load();
}

export function apiUrl(path: string): string {
  return runtime.apiUrl(path);
}
