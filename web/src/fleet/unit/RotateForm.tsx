import { useQueries, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { fetchRigs } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import {
  fetchUnit,
  rotateTyres,
  type Rotation,
  type RotationMove,
  type Unit,
  type UnitPosition,
} from "../../api/units";
import { useFormMutation } from "../useFormMutation";
import { ODOMETER_REFUSAL, ODOMETER_REQUIRED, readOdometer } from "./odometer";
import { openFitmentsKey, rigsKey, unitFitmentsKey, unitKey } from "./queryKeys";

// app.rotate_tyres refuses the whole set or none, reaching TY009/TY012/
// TY014, no occupancy code since targets are freed in the same statement.
// TY009 arrives from the rows the write closes (FR-FIT-002), which is why
// odometers are asked for rather than offered.
const ROTATE_WORDING = {
  speakable: ["TY009", "TY012", "TY014"],
  forbidden: "You do not have permission to rotate tyres.",
  fallback: "The rotation could not be applied. Try again, or call support if it keeps happening.",
};

const TOO_FEW =
  "Pick at least two positions: a rotation moves tyres between positions of this unit or its rig.";
const INCOMPLETE = "Every picked position needs a target and a tread reading.";

// BR-VEH-003/cellKey pattern: see cellKey in capture/draft.ts. Every occupancy
// answer here is on the pair, which is also the pair app.rotate_tyres
// checks (U18).
function pairKey(unitId: string, positionId: string): string {
  return `${unitId} ${positionId}`;
}

// FR-FIT-010: one set of moves across one open rig, all or nothing. A
// tread per tyre (measured where it comes off), an odometer per unit
// (U20), never the same value twice (NFR-USE-006).
export function RotateForm({ unit }: { unit: Unit }) {
  const tenantKey = getDevTenantId() ?? "default";
  const occupied = unit.positions.filter((p) => p.fitment !== null);

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [treads, setTreads] = useState<Record<string, string>>({});
  const [odometers, setOdometers] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState("");

  // rigsKey is already paired with fetchRigs() by RigForm/RigList; one key
  // answered by two fetchers would hand whichever screen mounts second a
  // list it did not ask for.
  const rigs = useQuery({ queryKey: rigsKey(tenantKey), queryFn: () => fetchRigs() });
  const openRig = (rigs.data ?? []).find(
    (r) => r.effectiveTo === null && r.members.some((m) => m.vehicleId === unit.id),
  );
  const siblings = openRig?.members.filter((m) => m.vehicleId !== unit.id) ?? [];

  // useQueries, not a useQuery per member (rules of hooks), under the same
  // key UnitDetail already reads, so this picker and that screen never
  // disagree about what is fitted where.
  const siblingReads = useQueries({
    queries: siblings.map((m) => ({
      queryKey: unitKey(m.vehicleId),
      queryFn: () => fetchUnit(m.vehicleId),
      enabled: openRig !== undefined,
    })),
  });

  const loadedSiblings = new Map<string, Unit>();
  siblings.forEach((m, index) => {
    const read = siblingReads[index].data;
    if (read !== undefined) loadedSiblings.set(m.vehicleId, read);
  });

  // In the rig's own member order (U7), so the picker reads down the vehicle
  // the way a controller walks it.
  const rigUnits: Unit[] =
    openRig === undefined
      ? [unit]
      : openRig.members.flatMap((m) => {
          if (m.vehicleId === unit.id) return [unit];
          const sibling = loadedSiblings.get(m.vehicleId);
          return sibling === undefined ? [] : [sibling];
        });

  const rotate = useFormMutation({
    mutate: (vars: Rotation) => rotateTyres(unit.id, vars),
    // Every unit of the rig, not only this one: a move lands a fitment on
    // whichever unit it names, and membership, unlike the picked set, is
    // still true at the moment onSuccess clears the form.
    invalidate: [
      ...rigUnits.flatMap((u) => [unitKey(u.id), unitFitmentsKey(u.id)]),
      openFitmentsKey(tenantKey),
    ],
    onSuccess: () => {
      setPicked({});
      setDestinations({});
      setTargets({});
      setTreads({});
      setOdometers({});
    },
  });

  const chosen = occupied.filter((p) => picked[p.id]);

  function destinationOf(positionId: string): string {
    return destinations[positionId] ?? unit.id;
  }

  // TYRE-127: a target is offerable when empty, or emptied by this same
  // set of moves, since app.rotate_tyres closes every row before opening
  // any.
  const vacated = new Set(chosen.map((p) => pairKey(unit.id, p.id)));

  function targetsFor(unitId: string): UnitPosition[] {
    const destination = rigUnits.find((u) => u.id === unitId);
    return (destination?.positions ?? []).filter(
      (p) => p.fitment === null || vacated.has(pairKey(unitId, p.id)),
    );
  }

  const touched = new Set([unit.id, ...chosen.map((p) => destinationOf(p.id))]);
  const involved = rigUnits.filter((u) => touched.has(u.id));
  const perUnit = involved.length > 1;
  const needReadings = involved.filter((u) => u.hasOdometer);

  function submit(e: FormEvent) {
    e.preventDefault();
    // D7 makes this form the two-or-more case. One position moving is a
    // removal and a fit, which the position panel already does and which
    // records a different pair of events.
    if (chosen.length < 2) {
      setRefused(TOO_FEW);
      return;
    }
    const moves: RotationMove[] = [];
    for (const position of chosen) {
      const target = targets[position.id] ?? "";
      const tread = (treads[position.id] ?? "").trim();
      // The target is re-read from the picker rather than trusted: what is
      // offerable depends on the whole picked set, so unchecking one row can
      // take a position back out of another row's list while that row's state
      // still names it. Enforcing it here covers every path that can shrink
      // the set, not only the two events that clear a selection.
      const offerable = targetsFor(destinationOf(position.id)).some((p) => p.id === target);
      if (target === "" || tread === "" || position.fitment === null || !offerable) {
        setRefused(INCOMPLETE);
        return;
      }
      const move: RotationMove = {
        tyreId: position.fitment.tyreId,
        toPositionId: target,
        treadMm: tread,
      };
      if (destinationOf(position.id) !== unit.id) {
        move.toVehicleId = destinationOf(position.id);
      }
      moves.push(move);
    }
    const readings: Record<string, number> = {};
    for (const u of needReadings) {
      const typed = odometers[u.id] ?? "";
      if (typed.trim() === "") {
        setRefused(ODOMETER_REQUIRED);
        return;
      }
      const reading = readOdometer(typed);
      if (!reading.ok || reading.value === undefined) {
        setRefused(ODOMETER_REFUSAL);
        return;
      }
      readings[u.id] = reading.value;
    }
    const body: Rotation = { moves };
    if (perUnit) {
      // Omitted rather than sent empty when no unit involved has an odometer:
      // two trailers give no readings at all, which is not the same request as
      // one naming units with none.
      if (needReadings.length > 0) body.odometers = readings;
    } else if (unit.hasOdometer) {
      body.odometer = readings[unit.id];
    }
    setRefused("");
    rotate.submit(body);
  }

  if (occupied.length === 0) {
    return (
      <section className="unit-rotate" aria-labelledby="rotate-heading">
        <h2 id="rotate-heading">Rotate</h2>
        <p>This unit carries no tyres to rotate.</p>
      </section>
    );
  }

  return (
    <section className="unit-rotate" aria-labelledby="rotate-heading">
      <h2 id="rotate-heading">Rotate</h2>
      <form onSubmit={submit}>
        <ul className="unit-rotate-rows">
          {occupied.map((p) => (
            <li key={p.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Rotate ${p.code}`}
                  checked={picked[p.id] ?? false}
                  onChange={(e) => {
                    setPicked({ ...picked, [p.id]: e.target.checked });
                    // Dropped with the row, like the destination select drops
                    // it: a target chosen against one picked set is not a
                    // target the next one has to offer.
                    if (!e.target.checked) setTargets({ ...targets, [p.id]: "" });
                  }}
                />
                {p.code}
              </label>

              {picked[p.id] && (
                <>
                  {openRig !== undefined && (
                    <select
                      aria-label={`Unit for ${p.code}`}
                      value={destinationOf(p.id)}
                      onChange={(e) => {
                        setDestinations({ ...destinations, [p.id]: e.target.value });
                        // Cleared with the unit: the same position id is legal
                        // on both links of a superlink, so a carried selection
                        // names a position this picker does not offer.
                        setTargets({ ...targets, [p.id]: "" });
                      }}
                    >
                      {rigUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.fleetNumber}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    aria-label={`Target for ${p.code}`}
                    value={targets[p.id] ?? ""}
                    onChange={(e) => setTargets({ ...targets, [p.id]: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {targetsFor(destinationOf(p.id)).map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.code}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Tread for ${p.code}`}
                    inputMode="decimal"
                    value={treads[p.id] ?? ""}
                    onChange={(e) => setTreads({ ...treads, [p.id]: e.target.value })}
                  />
                </>
              )}
            </li>
          ))}
        </ul>

        {perUnit
          ? needReadings.map((u) => (
              <label className="unit-rotate-odometer" key={u.id}>
                {`Odometer for ${u.fleetNumber}`}
                <input
                  inputMode="numeric"
                  value={odometers[u.id] ?? ""}
                  onChange={(e) => setOdometers({ ...odometers, [u.id]: e.target.value })}
                  required
                />
              </label>
            ))
          : unit.hasOdometer && (
              <label className="unit-rotate-odometer">
                Odometer
                <input
                  inputMode="numeric"
                  value={odometers[unit.id] ?? ""}
                  onChange={(e) => setOdometers({ ...odometers, [unit.id]: e.target.value })}
                  required
                />
              </label>
            )}

        <button className="btn-primary" type="submit" disabled={rotate.isPending}>
          {rotate.isPending ? "Rotating…" : "Rotate"}
        </button>
      </form>

      {/* useFormMutation keeps isSuccess for the life of the form, so a guard
          that stops the next attempt would otherwise leave "The rotation was
          applied" standing beside the sentence saying nothing was sent. */}
      {rotate.isSuccess && refused === "" && <p role="status">The rotation was applied.</p>}
      {refused !== "" && <p role="alert">{refused}</p>}
      {rotate.error !== null && <p role="alert">{refusalMessage(rotate.error, ROTATE_WORDING)}</p>}
    </section>
  );
}
