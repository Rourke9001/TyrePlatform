import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { CaptureDone } from "./CaptureDone";

describe("CaptureDone", () => {
  it("says the inspection is saved and asks for a sign-in when a 401 is holding it", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={401} />);
    expect(screen.getByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to send it.")).toBeInTheDocument();
  });

  // Signal does not clear these holds, so the screen says what the gate screen
  // for each one says (spec section 4, The indicator).
  it.each([
    [503, "auth_unavailable", "Sign-in is unavailable right now. Try again shortly."],
    [403, "tenant_inactive", "This company's account is not active. Contact your fleet office."],
    [403, "not_provisioned", "Ask your fleet office to set up your account."],
  ])("says what a %i %s hold needs instead of promising a send", (status, code, sentence) => {
    render(<CaptureDone state="queued" lastCode={code} lastStatus={status} />);
    expect(screen.getByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText(/when you have signal/)).not.toBeInTheDocument();
  });

  // TYRE-215: the phone's clock holds a TY021 entry, not signal, so the
  // screen says what the outbox band says.
  it("says the phone clock is ahead when that is what holds it", () => {
    render(<CaptureDone state="queued" lastCode="TY021" lastStatus={422} />);
    expect(screen.getByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "This phone's clock is ahead, so the office could not accept it yet. It will send later. Check the time.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/when you have signal/)).not.toBeInTheDocument();
  });

  // The server answered, so signal is not what holds it.
  it.each([
    [500, null],
    [429, null],
    [503, "concurrent_change"],
  ])("says the server holds a %i %s, not signal", (status, code) => {
    render(<CaptureDone state="queued" lastCode={code} lastStatus={status} />);
    expect(
      screen.getByText("The server could not take it yet. It will send by itself."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/when you have signal/)).not.toBeInTheDocument();
  });

  it("keeps the signal wording for any other hold", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={null} />);
    expect(screen.getByText(/when you have signal/)).toBeInTheDocument();
  });

  // CR-010/OR-LEG-001 (TYRE-207): every outcome a driver can be shown.
  it.each([
    ["sent", null, null, /inspection sent/],
    ["queued", null, null, /when you have signal/],
    ["queued", "TY021", 422, /clock is ahead/],
    ["failed", "TY003", 409, /already inspected/],
    ["failed", null, 422, /could not accept this inspection/],
  ] as const)(
    "says nothing forbidden when %s with code %s",
    (state, lastCode, lastStatus, present) => {
      const { container } = render(
        <CaptureDone state={state} lastCode={lastCode} lastStatus={lastStatus} />,
      );
      expectNothingForbiddenSpoken(container, present);
    },
  );
});
