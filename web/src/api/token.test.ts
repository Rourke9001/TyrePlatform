import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIRROR_KEY,
  SUBJECT_KEY,
  authConfigured,
  bearerMode,
  clearMirror,
  lastKnownSubject,
  readMirror,
  rememberSubject,
  rememberTenant,
  writeMirror,
  type Mirror,
} from "./token";

const MIRROR: Mirror = {
  accessToken: "at-1",
  expiresAt: Date.now() + 3_600_000,
  obtainedAt: Date.now(),
  subject: "oid-a",
  tenantId: null,
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the mirror", () => {
  it("reads back what was written", () => {
    writeMirror(MIRROR);
    expect(readMirror()).toEqual(MIRROR);
  });

  // A half-written or hand-edited value is no session at all, never a throw
  // on the path every API call takes.
  it("reads malformed JSON or the wrong shape as no mirror", () => {
    window.localStorage.setItem(MIRROR_KEY, "{not json");
    expect(readMirror()).toBeNull();
    window.localStorage.setItem(MIRROR_KEY, JSON.stringify({ accessToken: 1 }));
    expect(readMirror()).toBeNull();
  });

  it("clears the mirror and leaves the last-known subject alone", () => {
    writeMirror(MIRROR);
    rememberSubject("oid-a");
    clearMirror();
    expect(readMirror()).toBeNull();
    expect(lastKnownSubject()).toBe("oid-a");
    expect(window.localStorage.getItem(SUBJECT_KEY)).toBe("oid-a");
  });

  it("records the tenant /api/me proved, and does nothing without a mirror", () => {
    rememberTenant("t-1");
    expect(readMirror()).toBeNull();
    writeMirror(MIRROR);
    rememberTenant("t-1");
    expect(readMirror()?.tenantId).toBe("t-1");
  });

  // A full store must not fail a successful /api/me (me.ts calls this).
  it("does not throw when the store is full", () => {
    writeMirror(MIRROR);
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      expect(() => rememberTenant("t-2")).not.toThrow();
    } finally {
      full.mockRestore();
    }
  });
});

describe("the DEV bearer flag", () => {
  it("is off by default under vitest and on when the flag says bearer", () => {
    expect(bearerMode()).toBe(false);
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    expect(bearerMode()).toBe(true);
  });
});

describe("authConfigured", () => {
  it("is false until all three VITE_AUTH_* values are set", () => {
    expect(authConfigured()).toBe(false);
    vi.stubEnv("VITE_AUTH_AUTHORITY", "https://idp.test/");
    vi.stubEnv("VITE_AUTH_CLIENT_ID", "pwa");
    expect(authConfigured()).toBe(false);
    vi.stubEnv("VITE_AUTH_API_SCOPE", "api://tyre-api/access_as_user");
    expect(authConfigured()).toBe(true);
  });
});
