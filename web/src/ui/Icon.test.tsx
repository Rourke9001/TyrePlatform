import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Icon, type IconGlyph } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import { CheckIcon } from "./icons/Check";

// Icon.tsx as text, to read what it imports.
const iconSource = Object.values(
  import.meta.glob<string>("./Icon.tsx", { query: "?raw", import: "default", eager: true }),
)[0];

// Every glyph module, so a module that renders nothing or more than one
// component is caught here rather than on a screen.
const glyphs = import.meta.glob<Record<string, IconGlyph>>("./icons/*.tsx", { eager: true });

describe("Icon", () => {
  // TYRE-447: Icon takes a glyph component, never a name, so a route's
  // bundle carries only the glyphs it imports.
  it("Icon renders only the icon imported", () => {
    const { container } = render(<Icon icon={CheckIcon} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    const shapes = svg?.querySelectorAll("path, circle, rect, ellipse") ?? [];
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toHaveAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
    expect(iconSource).toBeDefined();
    expect(iconSource).not.toMatch(/from\s+["']\.\/icons\//);
  });

  it("is hidden from assistive tech without a label", () => {
    const { container } = render(<Icon icon={AlertIcon} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("is an image named by its label when it carries meaning alone", () => {
    render(<Icon icon={AlertIcon} label="Needs a second look" />);
    const img = screen.getByRole("img", { name: "Needs a second look" });
    expect(img).not.toHaveAttribute("aria-hidden");
  });

  it("draws at the given size on a 24px grid and passes unknown props on", () => {
    const { container } = render(<Icon icon={CheckIcon} size={28} data-testid="glyph" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "28");
    expect(svg).toHaveAttribute("height", "28");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("data-testid", "glyph");
    expect(svg).toHaveClass("tr-icon");
  });

  // The Icon suffix keeps a glyph clear of a screen's own names, such as
  // react-router's Link (TYRE-447).
  it("has 42 glyph modules, each exporting one component named for its file plus Icon", () => {
    const entries = Object.entries(glyphs);
    expect(entries).toHaveLength(42);
    for (const [path, mod] of entries) {
      const name = `${/\.\/icons\/(\w+)\.tsx$/.exec(path)?.[1]}Icon`;
      expect(Object.keys(mod)).toEqual([name]);
      const { container, unmount } = render(<Icon icon={mod[name]} />);
      expect(container.querySelectorAll("svg > *").length).toBeGreaterThan(0);
      unmount();
    }
  });
});
