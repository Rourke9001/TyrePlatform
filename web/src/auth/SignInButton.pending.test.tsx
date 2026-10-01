import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignInButton } from "./SignInButton";

const signIn = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)));
vi.mock("./oidc", () => ({ signIn }));

// A gloved second tap on weak signal must not start a second redirect.
beforeEach(() => {
  signIn.mockClear();
});

// Back from the identity provider restores the page from the bfcache and the
// library's navigation resolves, so the button must not stay dead.
it("is enabled again once the start resolves", async () => {
  signIn.mockImplementationOnce(() => Promise.resolve());
  render(<SignInButton label="Sign in" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());
});

it("starts one sign-in however many times it is tapped", async () => {
  render(<SignInButton label="Sign in" />);
  const button = screen.getByRole("button", { name: "Sign in" });
  const user = userEvent.setup();
  await user.click(button);
  await user.click(button);
  await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  expect(button).toBeDisabled();
});
