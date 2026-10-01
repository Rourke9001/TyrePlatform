import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignOutButton } from "./SignOutButton";
import { clearDraft, db, startDraft } from "../capture/draft";

vi.mock("./oidc", () => ({
  signOut: vi.fn(() => Promise.resolve()),
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  renew: vi.fn(),
}));

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem("tyre.dev.auth", "bearer");
  window.localStorage.setItem("tyre.auth.subject", "oid-a");
  await db.open();
  await clearDraft();
  await db.table("outbox").clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function heldEntry(clientUuid: string, state: string) {
  return {
    clientUuid,
    state,
    payload: {},
    queuedAt: 0,
    attempts: 1,
    nextAttemptAt: 0,
    lastStatus: 409,
    lastCode: null,
    lastError: null,
    fleetNumber: null,
    driverSubject: "oid-a",
    legacy: false,
  };
}

describe("SignOutButton (PD-S3)", () => {
  it("is not offered when nobody has signed in on this phone, or under the DEV header path", () => {
    window.localStorage.removeItem("tyre.auth.subject");
    const { unmount } = render(<SignOutButton />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    unmount();
    window.localStorage.setItem("tyre.auth.subject", "oid-a");
    window.localStorage.removeItem("tyre.dev.auth");
    render(<SignOutButton />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("refuses while a draft is held, and says why", async () => {
    await startDraft({
      driverSubject: "oid-a",
      vehicleId: "v1",
      taskId: null,
      startedAt: "2026-09-30T06:00:00Z",
    });
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "1 inspection is still on this phone. You can sign out once it has sent, or once you remove one the office refused.",
    );
    const oidc = await import("./oidc");
    expect(oidc.signOut).not.toHaveBeenCalled();
  });

  it("counts every held entry and uses the plural", async () => {
    await db.table("outbox").bulkPut([heldEntry("u1", "queued"), heldEntry("u2", "sending")]);
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "2 inspections are still on this phone. You can sign out once they have sent, or once you remove one the office refused.",
    );
  });

  it("refuses while a refused entry is held too", async () => {
    await db.table("outbox").put(heldEntry("u1", "failed"));
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/still on this phone/);
  });

  it("signs out when nothing is held", async () => {
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
  });

  // Spec section 4, TYRE-317: an unreadable store holds nothing, so sign-out
  // goes on.
  it("signs out when the held work cannot be read", async () => {
    vi.spyOn(db, "table").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  // signOut() clears everything local before it can reject (offline, no
  // end-session metadata), so a rejection is signed out locally.
  it("does not throw or stick when signOut rejects after the local clear", async () => {
    const oidc = await import("./oidc");
    vi.mocked(oidc.signOut).mockImplementationOnce(() => {
      window.localStorage.removeItem("tyre.auth.subject");
      return Promise.reject(new Error("end-session metadata not loaded"));
    });
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // With the real signOut() the subject is cleared and the button hides; this
  // pins only that pending resets once the call settles.
  it("is tappable again once the sign-out settles", async () => {
    render(<SignOutButton />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled());
  });

  it("keeps keyboard focus while the guard reads, and ignores a second tap", async () => {
    render(<SignOutButton />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Sign out" });
    button.focus();
    await user.click(button);
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
  });

  it("marks the button aria-disabled while pending and ignores taps", async () => {
    let release: (n: number) => void = () => undefined;
    const outbox = await import("../capture/outbox");
    vi.spyOn(outbox, "heldCount").mockImplementation(
      () => new Promise<number>((resolve) => (release = resolve)),
    );
    render(<SignOutButton />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Sign out" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    release(0);
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    expect(outbox.heldCount).toHaveBeenCalledTimes(1);
  });

  it("keeps the live region mounted while empty", () => {
    render(<SignOutButton />);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("empties the live region before a repeat refusal so it is announced again", async () => {
    await db.table("outbox").put(heldEntry("u1", "failed"));
    render(<SignOutButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText(/still on this phone/);
    const seen: string[] = [];
    const region = screen.getByRole("status");
    const observer = new MutationObserver(() => seen.push(region.textContent ?? ""));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(seen.at(-1)).toMatch(/still on this phone/));
    observer.disconnect();
    expect(seen).toContain("");
  });

  it("clears a refusal once the work has gone", async () => {
    await db.table("outbox").put(heldEntry("u1", "failed"));
    render(<SignOutButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("status");
    await db.table("outbox").clear();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(""));
  });
});
