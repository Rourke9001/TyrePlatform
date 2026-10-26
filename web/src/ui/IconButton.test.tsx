import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./IconButton";
import { Close } from "./icons/Close";

describe("IconButton", () => {
  it("IconButton exposes its label", () => {
    const { container } = render(<IconButton label="Close" icon={Close} />);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button).toHaveAttribute("type", "button");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("carries its variant and glove size", () => {
    render(<IconButton label="Menu" icon={Close} variant="on-brand" size="glove" />);
    expect(screen.getByRole("button", { name: "Menu" })).toHaveClass(
      "tr-iconbtn",
      "tr-iconbtn--on-brand",
      "tr-iconbtn--glove",
    );
  });

  it("passes unknown props and the click through", async () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Close" icon={Close} onClick={onClick} data-testid="x" aria-expanded />,
    );
    const button = screen.getByTestId("x");
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
