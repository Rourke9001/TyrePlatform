import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { fetchDepots, patchUnit, type Unit, type UnitPatch } from "../../api/units";
import { useFormMutation } from "../useFormMutation";
import { depotsKey, unitKey, vehiclesKey } from "./queryKeys";

const EDIT_WORDING = {
  speakable: ["fleet_number_taken"],
  forbidden: "You do not have permission to edit this unit.",
  fallback: "The unit could not be saved. Try again, or call support if it keeps happening.",
};

const NOTHING_CHANGED = "Nothing has changed, so nothing was saved.";
const BLANK_KEPT =
  "A blank field is left unchanged: registration, description, body type and unit descriptor are edited here, never emptied.";

// The five text columns each hold three states server-side and this form can
// reach only two of them: a blank is read as absence, not as a clear, so a
// blanked field is deliberately not sent and the form says so rather than
// reporting a save the server declined to make. The two nullable ids are the
// opposite — "" is how they are cleared, which is why the depot picker's None
// option sends one. See patchUnit's comment in api/units.ts for the wire
// contract this follows (D5, FR-VEH-041).
function changedText(current: string, loaded: string | null): string | undefined {
  const trimmed = current.trim();
  if (trimmed === "" || trimmed === (loaded ?? "")) return undefined;
  return trimmed;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

// The snapshot after a save: what was sent, folded into what was loaded. The
// response's own unit is deliberately not taken whole — it also carries the
// fields this form did not send, and a change someone else made to one of
// those would enter the snapshot without ever reaching the screen, which is
// the revert the snapshot exists to prevent.
function withSaved(loaded: Unit, sent: UnitPatch): Unit {
  const next = { ...loaded };
  if (sent.fleetNumber !== undefined) next.fleetNumber = sent.fleetNumber;
  if (sent.registration !== undefined) next.registration = sent.registration;
  if (sent.description !== undefined) next.description = sent.description;
  if (sent.bodyType !== undefined) next.bodyType = sent.bodyType;
  if (sent.unitDescriptor !== undefined) next.unitDescriptor = sent.unitDescriptor;
  // "" on a nullable id is the clear, not a value (patchUnit's comment in
  // api/units.ts), so the snapshot holds the NULL the next read will.
  if (sent.homeDepotId !== undefined) {
    next.homeDepotId = sent.homeDepotId === "" ? null : sent.homeDepotId;
  }
  if (sent.tags !== undefined) next.tags = sent.tags;
  return next;
}

// FR-VEH-041's descriptive edit (D5). The axle layout is not a field and has
// no PATCH path at all: the API's refusal is what protects it, and this only
// shows what the unit is so nobody looks for the control (TYRE-94).
export function UnitEditForm({ unit }: { unit: Unit }) {
  const tenantKey = getDevTenantId() ?? "default";
  const depots = useQuery({ queryKey: depotsKey(tenantKey), queryFn: () => fetchDepots() });

  // What the fields were last known to hold server-side, which the prop stops
  // saying the moment the unit read refetches — on a window focus, or on any
  // write's invalidation. The diff below has to be against what the person
  // editing was shown: measured against a refetch carrying someone else's
  // change, an untouched field reads as an edit back to the old value and the
  // PATCH reverts them (FR-VEH-041, D5). It advances on each save, or a field
  // could not be edited twice in one sitting — typing back what was saved a
  // moment ago would match the mount value and be dropped as no change.
  const seed = useRef(unit);
  const sentPatch = useRef<UnitPatch | null>(null);

  const [fleetNumber, setFleetNumber] = useState(unit.fleetNumber);
  const [registration, setRegistration] = useState(unit.registration ?? "");
  const [description, setDescription] = useState(unit.description ?? "");
  const [bodyType, setBodyType] = useState(unit.bodyType ?? "");
  const [unitDescriptor, setUnitDescriptor] = useState(unit.unitDescriptor ?? "");
  const [homeDepotId, setHomeDepotId] = useState(unit.homeDepotId ?? "");
  const [tags, setTags] = useState(unit.tags.join(", "));
  // Two slots, not one: "nothing was saved" is a refusal and belongs in an
  // alert, while "your blank was left alone" is something to know about a
  // save that may well have happened (NFR-USE-005/010).
  const [refusal, setRefusal] = useState("");
  const [advisory, setAdvisory] = useState("");

  const save = useFormMutation({
    // Recorded here rather than at submit: useFormMutation drops a second
    // submit while one is in flight (rule 3 — a write is an event), and only
    // a body that was actually sent may advance the snapshot.
    mutate: (body: UnitPatch) => {
      sentPatch.current = body;
      return patchUnit(unit.id, body);
    },
    invalidate: [unitKey(unit.id), vehiclesKey(tenantKey)],
    onSuccess: () => {
      if (sentPatch.current !== null) seed.current = withSaved(seed.current, sentPatch.current);
      sentPatch.current = null;
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: UnitPatch = {};

    const loaded = seed.current;

    const nextRegistration = changedText(registration, loaded.registration);
    if (nextRegistration !== undefined) body.registration = nextRegistration;
    const nextDescription = changedText(description, loaded.description);
    if (nextDescription !== undefined) body.description = nextDescription;
    const nextBodyType = changedText(bodyType, loaded.bodyType);
    if (nextBodyType !== undefined) body.bodyType = nextBodyType;
    const nextDescriptor = changedText(unitDescriptor, loaded.unitDescriptor);
    if (nextDescriptor !== undefined) body.unitDescriptor = nextDescriptor;

    const blanked = [
      [registration, loaded.registration],
      [description, loaded.description],
      [bodyType, loaded.bodyType],
      [unitDescriptor, loaded.unitDescriptor],
    ].some(([current, was]) => (current ?? "").trim() === "" && (was ?? "") !== "");

    // fleet_number is NOT NULL (000001), so a blank one is asking for
    // something the column cannot hold rather than for no change. The input is
    // `required` and patchUnit's validate() owns the rule either way
    // (ADR-0013 decision 5), so an empty one is simply not a change to send.
    const trimmedFleet = fleetNumber.trim();
    if (trimmedFleet !== "" && trimmedFleet !== loaded.fleetNumber) {
      body.fleetNumber = trimmedFleet;
    }

    if (homeDepotId !== (loaded.homeDepotId ?? "")) body.homeDepotId = homeDepotId;

    const nextTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    if (!sameTags(nextTags, loaded.tags)) body.tags = nextTags;

    setAdvisory(blanked ? BLANK_KEPT : "");
    if (Object.keys(body).length === 0) {
      setRefusal(NOTHING_CHANGED);
      return;
    }
    setRefusal("");
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

        {/* operating_group_id is a patchable column with no field here: the API
            lists depots but exposes no read of the operating groups, so a
            picker could only invent the list. It is edited from this form when
            that read exists. */}
        {depots.isError ? (
          <div className="note-card" role="alert">
            <h3>Depots didn&apos;t load</h3>
            <p>The server could not be reached. Check your connection, then retry.</p>
            <button className="btn-primary" type="button" onClick={() => void depots.refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <>
            <label htmlFor="unit-home-depot">Home depot</label>
            <select
              id="unit-home-depot"
              value={homeDepotId}
              onChange={(e) => setHomeDepotId(e.target.value)}
            >
              {/* None stays selectable while the list loads: "" is how the
                  API clears the id, not a placeholder standing in for one
                  (patchUnit's comment in api/units.ts). The pending option
                  therefore carries no value of its own. */}
              <option value="">None</option>
              {depots.isPending && <option disabled>Loading…</option>}
              {(depots.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </>
        )}

        {/* One field, comma separated: app.vehicle_tag holds a replacement
            list per unit (FR-VEH-041, U6), so this posts the whole list and
            an empty one clears it. */}
        <label htmlFor="unit-tags">Tags</label>
        <input id="unit-tags" value={tags} onChange={(e) => setTags(e.target.value)} />

        <button className="btn-primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </form>

      {/* useFormMutation keeps isSuccess for the life of the form, so a later
          click that sends nothing must not leave "The unit was saved"
          standing beside the sentence saying it was not. */}
      {save.isSuccess && refusal === "" && <p role="status">The unit was saved.</p>}
      {advisory !== "" && <p role="status">{advisory}</p>}
      {refusal !== "" && <p role="alert">{refusal}</p>}
      {save.error !== null && <p role="alert">{refusalMessage(save.error, EDIT_WORDING)}</p>}
    </section>
  );
}
