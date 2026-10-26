import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { installThemeStyle } from "../../theme/themeStyle";
import { themes } from "../../theme/tokens";
import Gallery, { GalleryView } from "./Gallery";
import type { GallerySection } from "./types";

// Out of id order, so the sort is what puts them in order.
const sections: GallerySection[] = [
  { id: "b-second", title: "Second", render: () => <p>second sample</p> },
  { id: "a-first", title: "First", render: () => <p>first sample</p> },
];

const COLUMNS = [
  { name: "Daylight", theme: "light" },
  { name: "Night shift", theme: "dark" },
];

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.getElementById("tread-tokens")?.remove();
});

describe("Gallery", () => {
  it("renders every registered section in both columns", () => {
    render(<GalleryView sections={sections} />);
    for (const { name, theme } of COLUMNS) {
      const column = screen.getByRole("region", { name });
      expect(column).toHaveAttribute("data-theme", theme);
      const titles = within(column)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent);
      expect(titles).toEqual(["First", "Second"]);
      expect(within(column).getByText("first sample")).toBeInTheDocument();
      expect(within(column).getByText("second sample")).toBeInTheDocument();
    }
  });

  // The route's page reads the lanes' *.gallery.tsx files itself, so a
  // section a lane adds shows with no edit here (TYRE-447).
  it("shows each *.gallery.tsx section on the route's page", () => {
    const registered = import.meta.glob<{ section: GallerySection }>("./*.gallery.tsx", {
      eager: true,
    });
    render(<Gallery />);
    for (const { name } of COLUMNS) {
      const column = screen.getByRole("region", { name });
      for (const { section } of Object.values(registered)) {
        expect(
          within(column).getByRole("heading", { level: 3, name: section.title }),
        ).toBeInTheDocument();
      }
    }
  });

  // A [data-theme] subtree takes its own theme from the installed sheet,
  // whatever the root's (themeCss, TYRE-445).
  it("gallery light column stays light under a dark root", () => {
    installThemeStyle();
    document.documentElement.setAttribute("data-theme", "dark");
    render(<GalleryView sections={sections} />);
    const canvas = (el: Element) => getComputedStyle(el).getPropertyValue("--canvas").trim();
    expect(canvas(document.documentElement)).toBe(themes.dark.canvas);
    expect(canvas(screen.getByRole("region", { name: "Daylight" }))).toBe(themes.light.canvas);
    expect(canvas(screen.getByRole("region", { name: "Night shift" }))).toBe(themes.dark.canvas);
  });
});
