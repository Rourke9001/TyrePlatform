import { afterEach, expect, it, vi } from "vitest";

import { ApiError } from "./apiError";
import { credential, rememberSubject } from "./token";
import { suppressReloadWhile } from "../shell/chunkReload";
import { bearerSession } from "../test/bearerSession";

// Every case here wants the auth chunk to fail to load, as it does in a dead
// zone. token.ts reaches it only through a dynamic import.
vi.mock("../auth/oidc", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});
vi.mock("../shell/chunkReload", async (original) => ({
  ...(await original<typeof import("../shell/chunkReload")>()),
  suppressReloadWhile: vi.fn((p: Promise<unknown>) => p),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  window.localStorage.clear();
});

it("imports the chunk under the reload guard, and a failed import is neither a reload nor a 401", async () => {
  bearerSession();
  rememberSubject("oid-a");

  const error = await credential().catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ApiError);
  expect(suppressReloadWhile).toHaveBeenCalledTimes(1);
});

// A new phone, or any phone after sign-out, has no session to renew. Behind a
// captive portal the import would fail, and a failed import is not a 401, so
// nothing would offer sign-in (spec section 4, Renewal).
it("answers 401 signed_out without importing the chunk when no driver has signed in", async () => {
  bearerSession();

  const error = await credential().catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 401, code: "signed_out" });
  expect(suppressReloadWhile).not.toHaveBeenCalled();
});
