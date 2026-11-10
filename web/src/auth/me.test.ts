import { afterEach, expect, it, vi } from "vitest";

import { SUBJECT_KEY, TENANT_KEY } from "../api/token";
import { me } from "../test/fixtures";
import { fetchMe } from "./me";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// The branding cache key reads it at first paint (b9 spec, Cached state).
it("records the tenant GET /api/me proved", async () => {
  window.localStorage.setItem(SUBJECT_KEY, "oid-a");
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(me({ tenantId: "t-1" })), { status: 200 })),
    ),
  );
  await fetchMe();
  expect(window.localStorage.getItem(TENANT_KEY)).toBe("t-1");
});

// Another tab's sign-in clears the key and writes its own subject while this
// call is in flight, so the answer is the driver before's (TYRE-471 spec,
// The session).
it("records nothing when the last-known subject changed while the call was in flight", async () => {
  window.localStorage.setItem(SUBJECT_KEY, "oid-a");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      window.localStorage.removeItem(TENANT_KEY);
      window.localStorage.setItem(SUBJECT_KEY, "oid-b");
      return Promise.resolve(
        new Response(JSON.stringify(me({ tenantId: "t-1" })), { status: 200 }),
      );
    }),
  );
  await fetchMe();
  expect(window.localStorage.getItem(TENANT_KEY)).toBeNull();
});
