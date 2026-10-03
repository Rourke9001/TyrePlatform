import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SignOutButton } from "./SignOutButton";

// A hoisted throwing mock gives the chunk-import failure no signal causes; it
// needs its own file (TYRE-317).
vi.mock("./oidc", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("tyre.dev.auth", "bearer");
  window.localStorage.setItem("tyre.auth.subject", "oid-a");
});

it("says so, and stays signed in, when the sign-out chunk cannot load", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignOutButton />
    </QueryClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not sign out. Find signal and try again.",
  );
  expect(window.localStorage.getItem("tyre.auth.subject")).toBe("oid-a");
  expect(screen.getByRole("button", { name: "Sign out" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
});
