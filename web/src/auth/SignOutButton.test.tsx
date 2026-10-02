import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ActorProvider } from "./ActorProvider";
import { AuthGate } from "./AuthGate";
import { fetchMe } from "./me";
import { SignOutButton } from "./SignOutButton";
import { ApiError } from "../api/apiError";
import { clearDraft, db, startDraft } from "../capture/draft";
import type { HeldWork } from "../capture/outbox";
import { me } from "../test/fixtures";
import authCss from "./auth.css?raw";

vi.mock("./oidc", () => ({
  signOut: vi.fn(() => Promise.resolve()),
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  renew: vi.fn(),
}));
vi.mock("./me", () => ({ fetchMe: vi.fn() }));

// The shell mounts the button under main.tsx's QueryClientProvider.
function renderButton() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SignOutButton />
    </QueryClientProvider>,
  );
}

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

function openDraft() {
  return startDraft({
    driverSubject: "oid-a",
    vehicleId: "v1",
    taskId: null,
    startedAt: "2026-09-30T06:00:00Z",
  });
}

describe("SignOutButton (PD-S3)", () => {
  it("is not offered when nobody has signed in on this phone, or under the DEV header path", () => {
    window.localStorage.removeItem("tyre.auth.subject");
    const { unmount } = renderButton();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    unmount();
    window.localStorage.setItem("tyre.auth.subject", "oid-a");
    window.localStorage.removeItem("tyre.dev.auth");
    renderButton();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  // U108: a draft never sends by itself, so the refusal names finishing it.
  it("refuses while a draft is held, and says to finish it", async () => {
    await openDraft();
    renderButton();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "You can't sign out yet. An inspection is still open on this phone. Finish it, then sign out.",
      ),
    );
    const oidc = await import("./oidc");
    expect(oidc.signOut).not.toHaveBeenCalled();
  });

  it("names the draft and the entries when both are held", async () => {
    await openDraft();
    await db.table("outbox").put(heldEntry("u1", "queued"));
    const { unmount } = renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "You can't sign out yet. An inspection is still open on this phone. Finish it. 1 more is on this phone too. Sign out once that one has sent, or remove it if the office refused it.",
      ),
    );
    unmount();

    await db.table("outbox").put(heldEntry("u2", "failed"));
    renderButton();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "You can't sign out yet. An inspection is still open on this phone. Finish it. 2 more are on this phone too. Sign out once they have sent, or remove any the office refused.",
      ),
    );
  });

  it("counts every held entry and uses the plural", async () => {
    await db.table("outbox").bulkPut([heldEntry("u1", "queued"), heldEntry("u2", "sending")]);
    renderButton();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "You can't sign out yet. 2 inspections are still on this phone. Sign out once they have sent, or remove any the office refused.",
    );
  });

  it("refuses while a refused entry is held too", async () => {
    await db.table("outbox").put(heldEntry("u1", "failed"));
    renderButton();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/still on this phone/);
  });

  it("signs out when nothing is held", async () => {
    renderButton();
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
    renderButton();
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
    renderButton();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // With the real signOut() the subject is cleared and the button hides; this
  // pins only that pending resets once the call settles.
  it("is tappable again once the sign-out settles", async () => {
    renderButton();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign out" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
  });

  it("keeps keyboard focus while the guard reads, and ignores a second tap", async () => {
    renderButton();
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
    let release: (held: HeldWork) => void = () => undefined;
    const outbox = await import("../capture/outbox");
    vi.spyOn(outbox, "heldCount").mockImplementation(
      () => new Promise<HeldWork>((resolve) => (release = resolve)),
    );
    renderButton();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Sign out" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    release({ draft: false, entries: 0 });
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    expect(outbox.heldCount).toHaveBeenCalledTimes(1);
  });

  // U109: the guard may yet refuse, so the label changes only once it has
  // passed and the sign-out chunk starts to load.
  it("says Sign out while the guard reads, and Signing out only once it has passed", async () => {
    let release: (held: HeldWork) => void = () => undefined;
    const outbox = await import("../capture/outbox");
    vi.spyOn(outbox, "heldCount").mockImplementation(
      () => new Promise<HeldWork>((resolve) => (release = resolve)),
    );
    const oidc = await import("./oidc");
    vi.mocked(oidc.signOut).mockImplementationOnce(() => new Promise(() => undefined));
    renderButton();
    const button = screen.getByRole("button", { name: "Sign out" });
    await userEvent.setup().click(button);

    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleName("Sign out");

    release({ draft: false, entries: 0 });
    await vi.waitFor(() => expect(button).toHaveAccessibleName("Signing out…"));
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the live region mounted while empty", () => {
    renderButton();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  // Vitest loads no stylesheet, so this one is put in the document. A region
  // that leaves the accessibility tree while empty is inserted, not updated,
  // by its first message, and screen readers announce that unreliably.
  it("keeps the empty live region in the accessibility tree under auth.css", () => {
    const style = document.createElement("style");
    style.textContent = authCss;
    document.head.append(style);
    try {
      renderButton();
      expect(screen.getByRole("status")).toHaveTextContent("");
    } finally {
      style.remove();
    }
  });

  it("empties the live region before a repeat refusal so it is announced again", async () => {
    await db.table("outbox").put(heldEntry("u1", "failed"));
    renderButton();
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
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText(/still on this phone/);
    await db.table("outbox").clear();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signOut).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});

// Spec section 4, Signing out: a rejected sign-out, or a back-forward restore
// of its navigation, leaves the page in place with the old actor cached.
describe("a sign-out the page outlives", () => {
  it("asks /api/me again and shows the sign-in screen, not the old actor", async () => {
    vi.mocked(fetchMe)
      .mockResolvedValueOnce(me({ displayName: "Driver A" }))
      .mockRejectedValue(new ApiError(401, "x", "unauthorized"));
    const oidc = await import("./oidc");
    vi.mocked(oidc.signOut).mockImplementationOnce(() => {
      window.localStorage.removeItem("tyre.auth.subject");
      return Promise.reject(new Error("end-session metadata not loaded"));
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ActorProvider>
          <SignOutButton />
          <AuthGate>
            <p>the routes</p>
          </AuthGate>
        </ActorProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("the routes")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("the routes")).toBeNull();
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });
});
