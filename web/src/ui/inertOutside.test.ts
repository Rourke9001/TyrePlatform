import { afterEach, describe, expect, it } from "vitest";

import { inertOutside } from "./inertOutside";

afterEach(() => {
  document.body.replaceChildren();
});

// <body><header/><main><nav/><div layer><button/></div></main><aside inert/></body>
function page() {
  const header = document.createElement("header");
  const main = document.createElement("main");
  const nav = document.createElement("nav");
  const layer = document.createElement("div");
  const inside = document.createElement("button");
  const aside = document.createElement("aside");
  aside.setAttribute("inert", "");
  layer.append(inside);
  main.append(nav, layer);
  document.body.append(header, main, aside);
  return { header, main, nav, layer, inside, aside };
}

describe("inertOutside", () => {
  it("makes every element outside the layer inert, up to the body, and nothing inside it", () => {
    const { header, main, nav, layer, inside } = page();
    inertOutside(layer);
    expect(nav.closest("[inert]")).toBe(nav);
    expect(header.closest("[inert]")).toBe(header);
    expect(main.hasAttribute("inert")).toBe(false);
    expect(layer.closest("[inert]")).toBeNull();
    expect(inside.closest("[inert]")).toBeNull();
  });

  // CaptureFlow's storage alert can mount while a sheet is open, and is heard at once.
  it("leaves an element mounted after the call alone", () => {
    const { main, layer } = page();
    inertOutside(layer);
    const late = document.createElement("div");
    main.append(late);
    expect(late.closest("[inert]")).toBeNull();
  });

  it("clears only what it set, so an element already inert stays inert", () => {
    const { header, nav, layer, aside } = page();
    const release = inertOutside(layer);
    release?.();
    expect(nav.hasAttribute("inert")).toBe(false);
    expect(header.hasAttribute("inert")).toBe(false);
    expect(aside.hasAttribute("inert")).toBe(true);
  });
});
