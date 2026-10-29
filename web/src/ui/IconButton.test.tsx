import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./IconButton";
import iconCss from "./IconButton.css?raw";
import { CloseIcon } from "./icons/Close";

describe("IconButton", () => {
  it("IconButton exposes its label", () => {
    const { container } = render(<IconButton label="Close" icon={CloseIcon} />);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button).toHaveAttribute("type", "button");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("carries its variant and glove size", () => {
    render(<IconButton label="Menu" icon={CloseIcon} variant="on-brand" size="glove" />);
    expect(screen.getByRole("button", { name: "Menu" })).toHaveClass(
      "tr-iconbtn",
      "tr-iconbtn--on-brand",
      "tr-iconbtn--glove",
    );
  });

  it("passes unknown props and the click through", async () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Close" icon={CloseIcon} onClick={onClick} data-testid="x" aria-expanded />,
    );
    const button = screen.getByTestId("x");
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // The button has no visible word, so its name always comes from label.
  it("keeps its label as its name when a caller passes aria-label", () => {
    render(
      <>
        <IconButton label="Close" icon={CloseIcon} aria-label={undefined} />
        <IconButton label="Refresh" icon={CloseIcon} aria-label="Something else" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  // jsdom applies no CSS, so the disabled look is read from the sheet.
  it("looks disabled when disabled, with no hover tint", () => {
    const bare = iconCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bare).toMatch(/\.tr-iconbtn:disabled \{[^}]*cursor: not-allowed;/);
    expect(bare).not.toMatch(/:hover \{/);
  });

  // --ink-muted on the brand measures 1.32:1 on the default brand in
  // Daylight, so a disabled glyph there keeps --on-brand and fades instead.
  // The rule ties .tr-iconbtn:disabled on specificity, so it must come later.
  it("keeps a disabled on-brand glyph in the on-brand colour", () => {
    const bare = iconCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.tr-iconbtn--on-brand:disabled \{([^}]*)\}/.exec(bare);
    expect(rule?.[1]).toMatch(/color: var\(--on-brand\);/);
    expect(rule?.[1]).toMatch(/opacity: 0\.55;/);
    expect(rule?.index).toBeGreaterThan(bare.indexOf(".tr-iconbtn:disabled {"));
  });
});
