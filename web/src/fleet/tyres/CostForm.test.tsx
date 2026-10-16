import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CostForm } from "./CostForm";
import type { Tyre } from "../../api/tyres";
import { renderWithActor, requestedUrl, respond, sentBody } from "../../test/fixtures";

const TYRE: Tyre = {
  id: "t1",
  displayCode: "POS1",
  state: "IN_STOCK",
  status: "OK",
  retreadCount: 0,
  sizeName: "295/80R22.5",
  brandName: "Bridgestone",
  patternName: "R150",
  receivedDate: "2026-01-05",
  awaitingCost: true,
};

function renderForm() {
  return renderWithActor(<CostForm tyre={TYRE} tenantKey="tenant-a" />);
}

function costCalls() {
  return vi.mocked(fetch).mock.calls.filter(([input]) => requestedUrl(input).endsWith("/cost"));
}

// TYRE-419: pins that no cost source is sent until the user chooses one.
// CostForm.tsx holds the rule (NFR-PRO-002).
describe("setting a tyre's cost", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with no source chosen and refuses a save until one is", async () => {
    const { container } = renderForm();
    const source = screen.getByRole("combobox", { name: /cost source for POS1/i });
    expect(source).toHaveValue("");
    expect(screen.getByRole("option", { name: "Choose a source" })).toBeInTheDocument();

    await userEvent.type(
      screen.getByRole("textbox", { name: /purchase price for POS1/i }),
      "1234.50",
    );

    expect(screen.getByRole("button", { name: "Set cost" })).toBeDisabled();
    expect(screen.getByText(/choose where this price came from/i)).toBeInTheDocument();

    // fireEvent.submit reaches onSubmit past the disabled button and the
    // required select, so this proves submit()'s own guard; the flush lets a
    // request the guard failed to stop actually land.
    const form = container.querySelector("form");
    if (form === null) throw new Error("expected a form element");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(costCalls()).toHaveLength(0);
  });

  it("gives each row's hint its own id so a register of rows never repeats one", async () => {
    renderWithActor(
      <>
        <CostForm tyre={TYRE} tenantKey="tenant-a" />
        <CostForm tyre={{ ...TYRE, id: "t2", displayCode: "POS2" }} tenantKey="tenant-a" />
      </>,
    );
    for (const code of ["POS1", "POS2"]) {
      await userEvent.type(
        screen.getByRole("textbox", { name: new RegExp(`purchase price for ${code}`, "i") }),
        "10",
      );
    }

    const hints = screen.getAllByText(/choose where this price came from/i);
    expect(hints).toHaveLength(2);
    expect(hints[0]?.id).not.toBe(hints[1]?.id);
    ["POS1", "POS2"].forEach((code, i) => {
      const select = screen.getByRole("combobox", {
        name: new RegExp(`cost source for ${code}`, "i"),
      });
      expect(select.getAttribute("aria-describedby")).toBe(hints[i]?.id);
    });
  });

  it("sends the price as typed and the chosen source", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(201, {}));
    renderForm();

    await userEvent.type(
      screen.getByRole("textbox", { name: /purchase price for POS1/i }),
      "1234.50",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /cost source for POS1/i }),
      "PRICE_LIST_ESTIMATE",
    );
    await userEvent.click(screen.getByRole("button", { name: "Set cost" }));

    await waitFor(() => expect(costCalls()).toHaveLength(1));
    const index = vi.mocked(fetch).mock.calls.findIndex(([i]) => requestedUrl(i).endsWith("/cost"));
    expect(sentBody(index)).toStrictEqual({ price: "1234.50", source: "PRICE_LIST_ESTIMATE" });
  });

  it("returns to no source after a save, not to INVOICE", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(201, {}));
    renderForm();

    await userEvent.type(screen.getByRole("textbox", { name: /purchase price for POS1/i }), "99");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /cost source for POS1/i }),
      "INVOICE",
    );
    await userEvent.click(screen.getByRole("button", { name: "Set cost" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /cost source for POS1/i })).toHaveValue(""),
    );
  });
});
