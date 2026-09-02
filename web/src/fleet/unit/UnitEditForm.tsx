import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { fetchDepots, patchUnit, type Unit, type UnitPatch } from "../../api/units";
import { useFormMutation } from "../useFormMutation";
import { depotsKey, unitKey } from "./queryKeys";

const EDIT_WORDING = {
  speakable: ["fleet_number_taken"],
  forbidden: "You do not have permission to edit this unit.",
  fallback: "The unit could not be saved. Try again, or call support if it keeps happening.",
};

const NOTHING_CHANGED = "Nothing has changed, so nothing was saved.";
const BLANK_KEPT =
  "A blank field is left unchanged: registration, description, body type and unit descriptor are edited here, never emptied.";

// The five text columns each hold three states server-side and this form can
// reach only two of them: units.go:513-520 reads "" as absence — "edited,
// never emptied" — so a blanked field is deliberately not sent, and the form
// says so rather than reporting a save the server declined to make. The two
// nullable ids are the opposite: "" is how they are cleared, which is why
// the depot picker's None option sends one (D5, FR-VEH-041).
function changedText(current: string, loaded: string | null): string | undefined {
  const trimmed = current.trim();
  if (trimmed === "" || trimmed === (loaded ?? "")) return undefined;
  return trimmed;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

// FR-VEH-041's descriptive edit (D5). The axle layout is not a field and has
// no PATCH path at all: the API's refusal is what protects it, and this only
// shows what the unit is so nobody looks for the control (TYRE-94).
export function UnitEditForm({ unit }: { unit: Unit }) {
  const tenantKey = getDevTenantId() ?? "default";
  const depots = useQuery({ queryKey: depotsKey(tenantKey), queryFn: () => fetchDepots() });

  const [fleetNumber, setFleetNumber] = useState(unit.fleetNumber);
  const [registration, setRegistration] = useState(unit.registration ?? "");
  const [description, setDescription] = useState(unit.description ?? "");
  const [bodyType, setBodyType] = useState(unit.bodyType ?? "");
  const [unitDescriptor, setUnitDescriptor] = useState(unit.unitDescriptor ?? "");
  const [homeDepotId, setHomeDepotId] = useState(unit.homeDepotId ?? "");
  const [tags, setTags] = useState(unit.tags.join(", "));
  const [note, setNote] = useState("");

  const save = useFormMutation({
    mutate: (body: UnitPatch) => patchUnit(unit.id, body),
    invalidate: [unitKey(unit.id)],
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: UnitPatch = {};

    const nextRegistration = changedText(registration, unit.registration);
    if (nextRegistration !== undefined) body.registration = nextRegistration;
    const nextDescription = changedText(description, unit.description);
    if (nextDescription !== undefined) body.description = nextDescription;
    const nextBodyType = changedText(bodyType, unit.bodyType);
    if (nextBodyType !== undefined) body.bodyType = nextBodyType;
    const nextDescriptor = changedText(unitDescriptor, unit.unitDescriptor);
    if (nextDescriptor !== undefined) body.unitDescriptor = nextDescriptor;

    const blanked = [
      [registration, unit.registration],
      [description, unit.description],
      [bodyType, unit.bodyType],
      [unitDescriptor, unit.unitDescriptor],
    ].some(([current, loaded]) => (current ?? "").trim() === "" && (loaded ?? "") !== "");

    // fleet_number is NOT NULL (000001), so a blank one is asking for
    // something the column cannot hold rather than for no change.
    const trimmedFleet = fleetNumber.trim();
    if (trimmedFleet === "") {
      setNote("A unit must keep a fleet number.");
      return;
    }
    if (trimmedFleet !== unit.fleetNumber) body.fleetNumber = trimmedFleet;

    if (homeDepotId !== (unit.homeDepotId ?? "")) body.homeDepotId = homeDepotId;

    const nextTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    if (!sameTags(nextTags, unit.tags)) body.tags = nextTags;

    if (Object.keys(body).length === 0) {
      setNote(blanked ? BLANK_KEPT : NOTHING_CHANGED);
      return;
    }
    setNote(blanked ? BLANK_KEPT : "");
    save.submit(body);
  }

  return (
    <section className="unit-edit" aria-labelledby="unit-edit-heading">
      <h2 id="unit-edit-heading">Details</h2>

      <p className="unit-edit-layout">
        Axle layout: <strong>{unit.configurationName}</strong>
        {unit.hasHistory && (
          <span className="unit-edit-note">Read-only: this unit has history</span>
        )}
      </p>

      <form onSubmit={submit}>
        <label htmlFor="unit-fleet-number">Fleet number</label>
        <input
          id="unit-fleet-number"
          value={fleetNumber}
          onChange={(e) => setFleetNumber(e.target.value)}
          required
        />

        <label htmlFor="unit-registration">Registration</label>
        <input
          id="unit-registration"
          value={registration}
          onChange={(e) => setRegistration(e.target.value)}
        />

        <label htmlFor="unit-description">Description</label>
        <input
          id="unit-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <label htmlFor="unit-body-type">Body type</label>
        <input id="unit-body-type" value={bodyType} onChange={(e) => setBodyType(e.target.value)} />

        <label htmlFor="unit-descriptor">Unit descriptor</label>
        <input
          id="unit-descriptor"
          value={unitDescriptor}
          onChange={(e) => setUnitDescriptor(e.target.value)}
        />

        <label htmlFor="unit-home-depot">Home depot</label>
        <select
          id="unit-home-depot"
          value={homeDepotId}
          onChange={(e) => setHomeDepotId(e.target.value)}
        >
          <option value="">None</option>
          {(depots.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>

        {/* One field, comma separated: app.vehicle_tag holds a replacement
            list per unit (FR-VEH-041, U6), so this posts the whole list and
            an empty one clears it. */}
        <label htmlFor="unit-tags">Tags</label>
        <input id="unit-tags" value={tags} onChange={(e) => setTags(e.target.value)} />

        <button className="btn-primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </form>

      {save.isSuccess && <p role="status">The unit was saved.</p>}
      {note !== "" && <p role="alert">{note}</p>}
      {save.error !== null && <p role="alert">{refusalMessage(save.error, EDIT_WORDING)}</p>}
    </section>
  );
}
