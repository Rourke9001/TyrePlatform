import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";
import { Plus } from "./icons/Plus";

describe("Button", () => {
  it("defaults to type=button so a stray click never submits a form", () => {
    render(<Button>Refresh</Button>);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("type", "button");
  });

  it("carries its variant, size and block classes", () => {
    render(
      <Button variant="primary" size="glove" block>
        Start inspection
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Start inspection" });
    expect(button).toHaveClass("tr-btn", "tr-btn--primary", "tr-btn--glove", "tr-btn--block");
  });

  it("defaults to a secondary button at the 44px floor", () => {
    render(<Button>Cancel</Button>);
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button).toHaveClass("tr-btn--secondary");
    expect(button.className).not.toMatch(/tr-btn--(md|lg|glove)/);
  });

  it("Button renders a Link when given to", () => {
    render(
      <MemoryRouter>
        <Button to="/exceptions" variant="ghost" data-requirement="FR-DSH-002">
          See the list
        </Button>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "See the list" });
    expect(link).toHaveAttribute("href", "/exceptions");
    expect(link).toHaveClass("tr-btn", "tr-btn--ghost");
    expect(link).toHaveAttribute("data-requirement", "FR-DSH-002");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names itself by its words, with its icons hidden", () => {
    const { container } = render(
      <Button icon={Plus} iconEnd={Plus}>
        Add tyre
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Add tyre" })).toBeInTheDocument();
    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("is busy and disabled while loading, with the spinner in place of the icon", () => {
    const { container } = render(
      <Button icon={Plus} loading>
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".tr-btn__spinner")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("passes unknown props to the button", () => {
    render(
      <Button id="save" data-testid="save" aria-describedby="hint" type="submit">
        Save
      </Button>,
    );
    const button = screen.getByTestId("save");
    expect(button).toHaveAttribute("id", "save");
    expect(button).toHaveAttribute("aria-describedby", "hint");
    expect(button).toHaveAttribute("type", "submit");
  });
});
