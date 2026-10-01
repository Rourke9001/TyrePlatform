import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CaptureDone } from "./CaptureDone";

describe("CaptureDone", () => {
  it("says the inspection is saved and asks for a sign-in when a 401 is holding it", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={401} />);
    expect(screen.getByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to send it.")).toBeInTheDocument();
  });

  it("keeps the signal wording for any other hold", () => {
    render(<CaptureDone state="queued" lastCode={null} lastStatus={null} />);
    expect(screen.getByText(/when you have signal/)).toBeInTheDocument();
  });
});
