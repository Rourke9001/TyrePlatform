import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

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

  it("keeps the signal wording for any other hold", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={null} />);
    expect(screen.getByText(/when you have signal/)).toBeInTheDocument();
  });
});
