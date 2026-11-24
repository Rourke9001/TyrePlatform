import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoidInspectionDialog } from "./VoidInspectionDialog";
import { getDevTenantId } from "../../api/devTenant";
import type { InspectionUnit } from "../../api/inspections";
import {
  renderWithActor,
  requestedUrl,
  respond,
  sentBody,
  testQueryClient,
  unitInspection,
} from "../../test/fixtures";

const TENANT = getDevTenantId() ?? "default";

const UNITS: InspectionUnit[] = [
  { fleetNumber: "HORSE", vehicleId: "h1", inScope: true, addressed: true },
  { fleetNumber: "LINK6", vehicleId: "l6", inScope: true, addressed: false },
  { fleetNumber: "LINK12", vehicleId: null, inScope: false, addressed: false },
];

const INSPECTION = unitInspection({
  inspectionId: "i1",
  driver: { id: "d1", displayName: "Melusi" },
});

function renderDialog(client = testQueryClient()) {
  const onClose = vi.fn();
  const onVoided = vi.fn();
  const view = renderWithActor(
    <VoidInspectionDialog
      open
      onClose={onClose}
      inspection={INSPECTION}
      units={UNITS}
      when="20 Nov 2026 10:03"
      onVoided={onVoided}
    />,
    { capabilities: ["ViewFleet", "VoidInspection"], client },
  );
  return { ...view, onClose, onVoided, client };
}

function voids(): number {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => requestedUrl(input) === "/api/inspections/i1/void").length;
}

describe("the void dialog", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // IR-UI-009: a destructive action names what it affects.
  it("names the inspection and every unit it read, and says what a void does and does not do", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");

    expect(dialog).toHaveTextContent("20 Nov 2026 10:03");
    expect(dialog).toHaveTextContent("Melusi");
    const listed = within(within(dialog).getByRole("list")).getAllByRole("listitem");
    expect(listed.map((li) => li.textContent)).toEqual(["HORSE", "LINK6", "LINK12"]);
    expect(dialog).toHaveTextContent("stays on record, marked voided");
    expect(dialog).toHaveTextContent(
      "stop counting toward condition, exceptions, wear rates and values",
    );
    expect(dialog).toHaveTextContent("cannot be undone");
    expect(dialog).toHaveTextContent("does not ask for a new inspection");
  });

  it("asks for a reason and sends nothing without one", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "   ");
    await user.click(screen.getByRole("button", { name: "Void inspection" }));

    expect(screen.getByText("Give a reason for the void.")).toBeInTheDocument();
    // The error is read with the field it names (web-design-guidelines,
    // Forms: focus the first error on submit).
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveFocus();
    expect(voids()).toBe(0);
  });

  it("names the reason field and keeps the browser's autofill off it", () => {
    renderDialog();
    const reason = screen.getByRole("textbox", { name: "Reason" });
    expect(reason).toHaveAttribute("name", "reason");
    expect(reason).toHaveAttribute("autocomplete", "off");
  });

  // U248, Lead's call 22: the server's 200 bytes stay the authority.
  it("stops the reason at 200 characters", () => {
    renderDialog();
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveAttribute("maxLength", "200");
  });

  it("posts the reason, reports the void and marks every read it changes stale", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const client = testQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    const { onVoided } = renderDialog(client);

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(screen.getByRole("button", { name: "Void inspection" }));

    await waitFor(() => {
      expect(onVoided).toHaveBeenCalledOnce();
    });
    expect(sentBody(0)).toEqual({ reason: "wrong rig" });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["unit-inspections"],
        ["unit-inspection"],
        ["unit"],
        ["unit-condition"],
        ["dashboard", TENANT],
        ["spares", TENANT],
        ["exceptions", TENANT],
        ["at-risk", TENANT],
      ]),
    );
    expect(keys).toHaveLength(8);
  });

  it("shows a refusal in the dialog and stays open", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        respond(422, { code: "TY019", message: "this inspection is already voided" }),
      ),
    );
    const user = userEvent.setup();
    const { onClose, onVoided } = renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(screen.getByRole("button", { name: "Void inspection" }));

    expect(
      await within(screen.getByRole("dialog")).findByText("this inspection is already voided"),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onVoided).not.toHaveBeenCalled();
  });

  // Review Focus 3: under 200 characters, over 200 bytes.
  it("sends a reason the form allows and shows the server's refusal of its length", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(respond(422, { code: "invalid_submission", message: "reason is too long" })),
    );
    const user = userEvent.setup();
    renderDialog();

    const reason = "é".repeat(150);
    await user.click(screen.getByRole("textbox", { name: "Reason" }));
    await user.paste(reason);
    await user.click(screen.getByRole("button", { name: "Void inspection" }));

    expect(await screen.findByText("reason is too long")).toBeInTheDocument();
    expect(sentBody(0)).toEqual({ reason });
  });

  it("holds the dialog open while the void is pending, and sends one", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "wrong rig");
    const confirm = screen.getByRole("button", { name: "Void inspection" });
    await user.click(confirm);

    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Keep it" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(confirm);

    expect(onClose).not.toHaveBeenCalled();
    expect(voids()).toBe(1);
  });
});
