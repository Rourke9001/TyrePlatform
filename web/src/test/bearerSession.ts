import { vi } from "vitest";

// A DEV session on the bearer path with the sign-in build values set. The
// test's afterEach unstubs the env and clears localStorage.
export function bearerSession(): void {
  window.localStorage.setItem("tyre.dev.auth", "bearer");
  vi.stubEnv("VITE_AUTH_AUTHORITY", "https://idp.test/");
  vi.stubEnv("VITE_AUTH_CLIENT_ID", "pwa");
  vi.stubEnv("VITE_AUTH_API_SCOPE", "api://tyre-api/access_as_user");
}
