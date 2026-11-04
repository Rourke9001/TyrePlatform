import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignInButton } from "./SignInButton";

// Discovery before the redirect fails without a network (oidc.ts).
const signIn = vi.hoisted(() => vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
vi.mock("./oidc", () => ({ signIn }));

afterEach(() => {
  signIn.mockClear();
});

it("says so when the sign-in cannot start, and offers the button again", async () => {
  render(<SignInButton label="Sign in" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not start sign-in. Find signal and try again.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("aria-disabled", "false");
  expect(signIn).toHaveBeenCalledTimes(1);
});
