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
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute(
      "aria-disabled",
      "false",
    ),
  );
});

it("starts one sign-in however many times it is tapped", async () => {
  render(<SignInButton label="Sign in" />);
  const button = screen.getByRole("button", { name: "Sign in" });
  const user = userEvent.setup();
  await user.click(button);
  await user.click(button);
  await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  expect(button).toHaveAttribute("aria-disabled", "true");
});

// Disabling a focused button drops focus to the page; the failure line that
// may follow is announced with nothing focused.
it("keeps keyboard focus while the start is in flight", async () => {
  render(<SignInButton label="Sign in" />);
  const button = screen.getByRole("button", { name: "Sign in" });
  button.focus();
  await userEvent.setup().click(button);
  await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  expect(button).not.toBeDisabled();
  expect(button).toHaveFocus();
});

// The chunk can take seconds on weak signal; the label says it is working.
it("names what it is doing while the start is in flight", async () => {
  render(<SignInButton label="Sign in" />);
  const button = screen.getByRole("button", { name: "Sign in" });
  await userEvent.setup().click(button);
  await vi.waitFor(() => expect(button).toHaveAccessibleName("Opening sign-in…"));
});
