import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createRig, fetchRigs, type NewRig } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { fetchVehicles } from "../../api/vehicles";
import { useFormMutation } from "../useFormMutation";
import { rigsKey, vehiclesKey } from "../unit/queryKeys";
import "../fleet.css";

// app.create_combination's refusals that a controller can still hit after
// the client narrows the option lists (D2's table — kind, retirement and
// duplicate checks are pre-filtered below, but a second controller can win
// the race) plus the not-visible read.
const CREATE_WORDING = {
  speakable: ["TY017", "TY012"],
  forbidden: "You do not have permission to set a rig.",
  fallback: "The rig could not be set. Retry.",
};

// U9: DISPOSED and INACTIVE are retired states; PARKED, WORKSHOP and
// OUT_OF_SERVICE only pause a unit's schedule and still couple.
const RETIRED = new Set(["DISPOSED", "INACTIVE"]);

interface TowedRow {
  vehicleId: string;
  descriptor: string;
}

// D5: a motive select, an ordered towed list built from a trailer select
// with Add/Up/Down/Remove, and an effective-from date the browser never
// supplies a value for (rule 6). What may actually be coupled stays
// app.create_combination's alone (D2); this only keeps the common refusal
// from round-tripping.
export function RigForm() {
  const tenantKey = getDevTenantId() ?? "default";

  const rigs = useQuery({ queryKey: rigsKey(tenantKey), queryFn: () => fetchRigs() });
  const vehicles = useQuery({ queryKey: vehiclesKey(tenantKey), queryFn: fetchVehicles });

  const [motiveId, setMotiveId] = useState("");
  const [towed, setTowed] = useState<TowedRow[]>([]);
  const [trailerPick, setTrailerPick] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");

  const create = useFormMutation({
    mutate: (body: NewRig) => createRig(body),
    invalidate: [rigsKey(tenantKey), vehiclesKey(tenantKey)],
    onSuccess: () => {
      setMotiveId("");
      setTowed([]);
      setTrailerPick("");
      setEffectiveOn("");
    },
  });

  // U5/INV-4: a unit already coupled in an open rig cannot join another one
  // until that rig ends — app.combination_member_in_order's own rule
  // (D1.2), narrowed here so the option lists never offer a choice the
  // server would only refuse.
  const inOpenRig = new Set(
    (rigs.data ?? [])
      .filter((r) => r.effectiveTo === null)
      .flatMap((r) => r.members.map((m) => m.vehicleId)),
  );

  const motiveOptions = (vehicles.data ?? []).filter(
    (v) =>
      v.unitKind !== null &&
      v.unitKind !== "TRAILER" &&
      !RETIRED.has(v.status) &&
      !inOpenRig.has(v.id),
  );

  const towedIds = new Set(towed.map((t) => t.vehicleId));
  const trailerOptions = (vehicles.data ?? []).filter(
    (v) =>
      v.unitKind === "TRAILER" &&
      !RETIRED.has(v.status) &&
      !inOpenRig.has(v.id) &&
      !towedIds.has(v.id),
  );

  function fleetNumberOf(vehicleId: string): string {
    return vehicles.data?.find((v) => v.id === vehicleId)?.fleetNumber ?? vehicleId;
  }

  function addTrailer() {
    if (trailerPick === "") return;
    setTowed([...towed, { vehicleId: trailerPick, descriptor: "" }]);
    setTrailerPick("");
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= towed.length) return;
    const next = [...towed];
    [next[index], next[target]] = [next[target], next[index]];
    setTowed(next);
  }

  function remove(index: number) {
    setTowed(towed.filter((_, i) => i !== index));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (motiveId === "" || towed.length === 0) return;
    const body: NewRig = {
      motiveVehicleId: motiveId,
      towed: towed.map((t) =>
        t.descriptor.trim() === ""
          ? { vehicleId: t.vehicleId }
          : { vehicleId: t.vehicleId, descriptor: t.descriptor.trim() },
      ),
    };
    // Never the browser's "today" (rule 6, lessons 2026-09-03): an empty
    // date omits effectiveOn entirely so the server resolves it in the
    // tenant's own zone (U8).
    if (effectiveOn.trim() !== "") {
      body.effectiveOn = effectiveOn;
    }
    create.submit(body);
  }

  return (
    <section className="tyres-receive" aria-labelledby="set-rig-heading">
      <h2 id="set-rig-heading">Set a rig</h2>
      <form onSubmit={submit}>
        <div className="tyres-row-form">
          <label htmlFor="rigMotive">Motive unit</label>
          <select id="rigMotive" value={motiveId} onChange={(e) => setMotiveId(e.target.value)}>
            <option value="">Choose…</option>
            {motiveOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.fleetNumber}
              </option>
            ))}
          </select>
        </div>

        <p>Towed, in walk order</p>
        <ul className="unit-rotate-rows">
          {towed.map((row, index) => {
            const fleetNumber = fleetNumberOf(row.vehicleId);
            return (
              <li key={row.vehicleId}>
                <span>{index + 1}</span>
                <span>{fleetNumber}</span>
                <input
                  aria-label={`Descriptor for ${fleetNumber}`}
                  placeholder="Descriptor"
                  value={row.descriptor}
                  onChange={(e) => {
                    const next = [...towed];
                    next[index] = { ...next[index], descriptor: e.target.value };
                    setTowed(next);
                  }}
                />
                <button
                  type="button"
                  aria-label={`Move ${fleetNumber} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  aria-label={`Move ${fleetNumber} down`}
                  disabled={index === towed.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${fleetNumber}`}
                  onClick={() => remove(index)}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>

        <div className="tyres-row-form">
          <label htmlFor="rigTrailer">Trailer</label>
          <select
            id="rigTrailer"
            value={trailerPick}
            onChange={(e) => setTrailerPick(e.target.value)}
          >
            <option value="">Choose…</option>
            {trailerOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.fleetNumber}
              </option>
            ))}
          </select>
          <button type="button" onClick={addTrailer}>
            Add
          </button>
        </div>

        <div className="tyres-row-form">
          <label htmlFor="rigEffectiveOn">Effective from</label>
          <input
            id="rigEffectiveOn"
            type="date"
            aria-label="Effective from"
            value={effectiveOn}
            onChange={(e) => setEffectiveOn(e.target.value)}
          />
        </div>
        <p className="tyres-receive-hint">Leave empty for today.</p>

        <button
          className="btn-primary"
          type="submit"
          disabled={motiveId === "" || towed.length === 0 || create.isPending}
        >
          {create.isPending ? "Setting…" : "Set rig"}
        </button>
      </form>

      {create.isSuccess && create.error === null && create.result && (
        <p role="status">Rig set for {create.result.motiveFleetNumber}.</p>
      )}
      {create.error !== null && <p role="alert">{refusalMessage(create.error, CREATE_WORDING)}</p>}
    </section>
  );
}
