import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("draws three busy lines, the last one shorter, and says it is loading", () => {
    const { container } = render(<Skeleton />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent(/^Loading$/);
    const lines = container.querySelectorAll<HTMLElement>(".tr-skel");
    expect(lines).toHaveLength(3);
    expect(lines[0].style.width).toBe("100%");
    expect(lines[2].style.width).toBe("60%");
    for (const line of lines) expect(line).toHaveAttribute("aria-hidden", "true");
  });

  it("takes a line count, height, last width and words", () => {
    const { container } = render(
      <Skeleton lines={2} height={20} lastWidth="40%" label="Loading the fleet" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading the fleet$/);
    const lines = container.querySelectorAll<HTMLElement>(".tr-skel");
    expect(lines).toHaveLength(2);
    expect(lines[1].style.height).toBe("20px");
    expect(lines[1].style.width).toBe("40%");
  });
});
