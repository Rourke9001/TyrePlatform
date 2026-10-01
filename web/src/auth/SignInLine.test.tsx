import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { credential } from "../api/token";
import { bearerSession } from "../test/bearerSession";
import { me } from "../test/fixtures";
import { ActorContext } from "./actorContext";
import { SignInLine } from "./SignInLine";
import authCss from "./auth.css?raw";

// A renewal that finds no session, which lapses the token store.
vi.mock("./oidc", () => ({ renew: vi.fn(() => Promise.resolve(null)) }));

beforeEach(() => {
  window.localStorage.clear();
  bearerSession();
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

// The region is in the accessibility tree before the lapse, so the lapse is an
// update a screen reader announces. The button sits outside it, so its label
// is not read as part of the status. Vitest loads no stylesheet, so auth.css
// is put in the document.
it("announces a lapse through a status region already in the tree, with the button outside it", async () => {
  const style = document.createElement("style");
  style.textContent = authCss;
  document.head.append(style);
  try {
    render(
      <ActorContext value={{ actor: me(), settled: true }}>
        <SignInLine />
      </ActorContext>,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

    await act(async () => {
      await credential().catch(() => undefined);
    });

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Your sign-in has run out. Sign in to carry on.");
    expect(region).not.toContainElement(screen.getByRole("button", { name: "Sign in" }));
  } finally {
    style.remove();
  }
});
