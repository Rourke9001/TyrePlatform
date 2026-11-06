import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { CaptureDone } from "./CaptureDone";
import { STAMP_HOLD_COPY } from "./outbox";

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
    expect(screen.queryByText(/open with signal/)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/open with signal/)).not.toBeInTheDocument();
  });

  // The server answered, so signal is not what holds it.
  it.each([
    [500, null],
    [429, null],
    [503, "concurrent_change"],
  ])("says the server holds a %i %s, not signal", (status, code) => {
    render(<CaptureDone state="queued" lastCode={code} lastStatus={status} />);
    expect(
      screen.getByText(
        "The server could not take it yet. It sends by itself while the app is open. You can close the app.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/open with signal/)).not.toBeInTheDocument();
  });

  it("keeps the signal wording for any other hold", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={null} />);
    expect(
      screen.getByText(
        "It sends by itself while the app is open with signal. You can close the app.",
      ),
    ).toBeInTheDocument();
  });

  // FR-OFF-009: nothing sends while the app is closed, so a line that lets the
  // driver close it says the send waits for the app to be open.
  it.each([
    [null, null],
    [500, null],
  ])("says a %s %s hold sends while the app is open", (status, code) => {
    render(<CaptureDone state="queued" lastCode={code} lastStatus={status} />);
    expect(screen.getByText(/You can close the app\.$/)).toHaveTextContent(/while the app is open/);
  });

  // U104: a refused stamp leaves no status, so the caller says it is the hold.
  it("names the capturing driver's sign-in when the stamp holds it", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={null} stampHeld />);
    expect(screen.getByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(
      screen.getByText("The driver who captured it needs to sign in here to send it."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/open with signal/)).not.toBeInTheDocument();
  });

  // U104: the stamp is decided before the recorded status, so an entry the
  // phone's subject may not carry gets the stamp line over a recorded 401.
  it("names the capturing driver's sign-in over a recorded 401 when the stamp holds it", () => {
    render(<CaptureDone state="queued" lastCode="signed_out" lastStatus={401} stampHeld />);
    expect(screen.getByText(STAMP_HOLD_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Sign in to send it.")).not.toBeInTheDocument();
  });

  // CR-010/OR-LEG-001 (TYRE-207): every outcome a driver can be shown.
  it.each([
    ["sent", null, null, /inspection sent/],
    ["queued", null, null, /open with signal/],
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
