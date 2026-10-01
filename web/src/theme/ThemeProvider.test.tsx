import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider } from "./ThemeProvider";
import { testQueryClient } from "../test/fixtures";

const BRANDING = { displayName: "Acme", primaryColor: "#123456", logoUrl: null };

function mount() {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <ThemeProvider>
        <p>app</p>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function brandingKeys(): string[] {
  return Object.keys(window.localStorage).filter((k) => k.startsWith("tyre.branding."));
}

function stubAuthEnv() {
  vi.stubEnv("VITE_AUTH_AUTHORITY", "https://idp.test/");
  vi.stubEnv("VITE_AUTH_CLIENT_ID", "pwa");
  vi.stubEnv("VITE_AUTH_API_SCOPE", "api://tyre-api/access_as_user");
}

function setMirror(tenantId: string | null) {
  window.localStorage.setItem(
    "tyre.auth.mirror",
    JSON.stringify({
      accessToken: "at",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: 0,
      subject: "oid-a",
      tenantId,
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(BRANDING), { status: 200 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the branding cache key", () => {
  it("is the signed-in tenant the mirror learnt from /api/me", async () => {
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    stubAuthEnv();
    setMirror("t-1");
    mount();
    await waitFor(() => expect(window.localStorage.getItem("tyre.branding.t-1")).not.toBeNull());
  });

  // A key every tenant shares would paint one company's brand for the next
  // person on the phone.
  it("caches nothing while the tenant is unknown", async () => {
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    stubAuthEnv();
    setMirror(null);
    mount();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    // Let the answer reach the query and the effects run, so a write that was
    // going to happen has happened before the absence is asserted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(brandingKeys()).toEqual([]);
  });

  it("stays on the dev tenant under the DEV header path", async () => {
    window.localStorage.setItem("tyre.dev.tenant-id", "dev-t");
    mount();
    await waitFor(() => expect(window.localStorage.getItem("tyre.branding.dev-t")).not.toBeNull());
  });
});
