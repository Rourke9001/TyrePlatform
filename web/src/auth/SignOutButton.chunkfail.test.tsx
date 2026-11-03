import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { page } from "../shell/chunkReload";
import { SignOutButton } from "./SignOutButton";

// A hoisted throwing mock gives the chunk-import failure no signal causes; it
// needs its own file (TYRE-317).
vi.mock("./oidc", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem("tyre.dev.auth", "bearer");
  window.localStorage.setItem("tyre.auth.subject", "oid-a");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderButton() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignOutButton />
    </QueryClientProvider>,
  );
}

it("says so, offline, and stays signed in, when the sign-out chunk cannot load", async () => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
  const reload = vi.spyOn(page, "reload").mockImplementation(() => undefined);
  renderButton();
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not sign out. Find signal and try again.",
  );
  expect(window.localStorage.getItem("tyre.auth.subject")).toBe("oid-a");
  expect(screen.getByRole("button", { name: "Sign out" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect(reload).not.toHaveBeenCalled();
});

// U105 (TYRE-381): the guard has passed, so nothing is held, and a reload is
// the only way to load the chunk again on Chrome and released Safari.
it("reloads, with a connection, when the sign-out chunk cannot load, and stays signed in", async () => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  const reload = vi.spyOn(page, "reload").mockImplementation(() => undefined);
  renderButton();
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(window.localStorage.getItem("tyre.auth.subject")).toBe("oid-a");
  // Held until the page goes, so a second tap cannot run the guard and the
  // import again (TYRE-381 stage 5).
  expect(screen.getByRole("button", { name: "Signing out…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
