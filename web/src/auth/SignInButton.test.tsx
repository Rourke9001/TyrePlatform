import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { page } from "../shell/chunkReload";
import { SignInButton } from "./SignInButton";

// Every case here wants the auth chunk to fail to load. SignInButton reaches
// it only through token.ts's dynamic import. That a renewal's failed import
// never reloads is pinned by token.chunkfail.test.ts.
vi.mock("./oidc", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("says so, offline, when the sign-in chunk cannot load, and does not reload", async () => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
  const reload = vi.spyOn(page, "reload").mockImplementation(() => undefined);
  render(<SignInButton label="Sign in" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not start sign-in. Find signal and try again.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("aria-disabled", "false");
  expect(reload).not.toHaveBeenCalled();
});

// U105 (TYRE-381): Chrome and released Safari keep the failed import in the
// module map, so with a connection only a reload loads the chunk again.
it("reloads, with a connection, when the sign-in chunk cannot load", async () => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  const reload = vi.spyOn(page, "reload").mockImplementation(() => undefined);
  render(<SignInButton label="Sign in" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).toBeNull();
});
