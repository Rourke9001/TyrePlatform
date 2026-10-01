import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { useEffect, useState } from "react";
import { ThemeProvider } from "./ThemeProvider";
import { useBranding } from "./themeContext";
import { ActorContext } from "../auth/actorContext";
import { me, testQueryClient } from "../test/fixtures";

const BRANDING = { displayName: "Acme", primaryColor: "#123456", logoUrl: null };

// Shows the fetched name, so a test can wait for the branding to land before
// it asserts that nothing was cached.
function Name() {
  return <p>{useBranding().branding.displayName}</p>;
}

function tree(actor: ReturnType<typeof me> | null) {
  return (
    <QueryClientProvider client={client}>
      <ActorContext.Provider value={{ actor, settled: actor !== null }}>
        <ThemeProvider>
          <Name />
        </ThemeProvider>
      </ActorContext.Provider>
    </QueryClientProvider>
  );
}

let client = testQueryClient();

function mount() {
  return render(tree(null));
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
  client = testQueryClient();
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
    await screen.findByText("Acme");
    expect(brandingKeys()).toEqual([]);
  });

  // Only the actor changes. ThemeProvider is not recreated and the mirror
  // stays unknown, so the move can come only from ThemeProvider reading the
  // actor (ADR-0016).
  it("moves to the tenant when /api/me answers, without a reload", async () => {
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    stubAuthEnv();
    setMirror(null);
    let setActor: (actor: ReturnType<typeof me>) => void = () => undefined;
    function Parent() {
      const [actor, set] = useState<ReturnType<typeof me> | null>(null);
      useEffect(() => {
        setActor = set;
      }, [set]);
      return (
        <QueryClientProvider client={client}>
          <ActorContext.Provider value={{ actor, settled: actor !== null }}>
            <ThemeProvider>
              <Name />
            </ThemeProvider>
          </ActorContext.Provider>
        </QueryClientProvider>
      );
    }
    render(<Parent />);
    await screen.findByText("Acme");
    expect(brandingKeys()).toEqual([]);

    act(() => setActor(me({ tenantId: "t-9" })));
    await waitFor(() => expect(window.localStorage.getItem("tyre.branding.t-9")).not.toBeNull());
  });

  it("stays on the dev tenant under the DEV header path", async () => {
    window.localStorage.setItem("tyre.dev.tenant-id", "dev-t");
    mount();
    await waitFor(() => expect(window.localStorage.getItem("tyre.branding.dev-t")).not.toBeNull());
  });
});
