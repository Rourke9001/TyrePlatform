import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { ListRow } from "./ListRow";

describe("ListRow", () => {
  it("ListRow children are the whole link text", () => {
    render(
      <MemoryRouter>
        <ul>
          <li>
            <ListRow to="/capture/v1?taskId=k1" data-task="k1">
              PC-T1, due 27 Oct (overdue)
            </ListRow>
          </li>
        </ul>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "PC-T1, due 27 Oct (overdue)" });
    expect(link).toHaveAttribute("href", "/capture/v1?taskId=k1");
    expect(link).toHaveAttribute("data-task", "k1");
    expect(link.textContent).toBe("PC-T1, due 27 Oct (overdue)");
    expect(screen.getByRole("listitem").textContent).toBe("PC-T1, due 27 Oct (overdue)");
  });

  it("is plain text when it has nowhere to go", () => {
    render(
      <ul>
        <li>
          <ListRow>HORSE</ListRow>
        </li>
      </ul>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("listitem").textContent).toBe("HORSE");
  });

  it("sets a title over its meta, with what trails it", () => {
    render(
      <MemoryRouter>
        <ListRow
          to="/fleet/v1"
          title="TRK-01"
          meta="Volvo FH, 6 tyres"
          trailing={<span>Check</span>}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /^TRK-01/ });
    expect(link).toHaveTextContent("Volvo FH, 6 tyres");
    expect(link).toHaveTextContent("Check");
  });

  it("is a button when given onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ListRow title="Receive tyres" onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Receive tyres" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
