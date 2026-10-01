import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignInButton } from "./SignInButton";

// Every case here wants the auth chunk to fail to load, as it does with no
// signal. SignInButton reaches it only through token.ts's dynamic import. That
// a failed import never reloads is pinned by chunkReload.test.ts and
// token.chunkfail.test.ts.
vi.mock("./oidc", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

it("says so when the sign-in chunk cannot load", async () => {
  render(<SignInButton label="Sign in" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not start sign-in. Find signal and try again.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
