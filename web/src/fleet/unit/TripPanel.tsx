import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { apiGet } from "../../api/client";
import { fetchRigs } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import {
  endTrip,
  fetchTripBlockers,
  fetchUnitTrip,
  startTrip,
  type NewTrip,
  type Trip,
  type UnitTrip,
} from "../../api/trips";
import type { Unit } from "../../api/units";
import type { Vehicle } from "../../api/vehicles";
import { useCan } from "../../auth/actorContext";
import { useTenantDate, useTenantInstant } from "../../time/tenantTime";
import { useFormMutation } from "../useFormMutation";
import { DriverPicker } from "./DriverPicker";
import { NominateControl } from "./NominateControl";
import { byNaturalCode } from "./naturalOrder";
import {
  driversKey,
  rigsKey,
  tripBlockersKey,
  tripBlockersPrefix,
  unitTasksPrefix,
  unitTripKey,
  unitTripsPrefix,
  vehiclesKey,
} from "./queryKeys";
import "../fleet.css";

// Every rule a start or an end meets is app.start_trip's or app.end_trip's
// (000060), so their refusals are shown in the server's words; TY017 is the
// rig write's, reached through an added trailer.
const TRIP_WORDING = {
  speakable: ["TY028", "TY018", "TY017", "TY012", "trip_overlaps"],
  forbidden: "You do not have permission to start or end a trip.",
  fallback: "The trip could not be changed. Retry.",
};

// As RigForm's: a retired unit is not coupled (U9).
const RETIRED = new Set(["DISPOSED", "INACTIVE"]);

// A start or an end changes who holds the motive and every unit it tows,
// what the rig register shows, whom the picker names as on a trip, and what
// holds a start.
function tripWriteKeys(tenantKey: string): QueryKey[] {
  return [
    unitTripsPrefix(),
    unitTasksPrefix(),
    rigsKey(tenantKey),
    driversKey(tenantKey),
    tripBlockersPrefix(),
  ];
}

// The unit screen's trip panel (spec, Trip screens): every ViewFleet reader
// sees it, and the start and end are ManageAssignments' (U2, D8). A trailer
// and a motive between trips both read as no trip and no motive, so which
// one this is comes from the unit's own kind.
export function TripPanel({ unit }: { unit: Unit }) {
  const trip = useQuery({ queryKey: unitTripKey(unit.id), queryFn: () => fetchUnitTrip(unit.id) });

  return (
    <section className="tyres-receive" aria-labelledby="trip-heading">
      <h2 id="trip-heading">Trip</h2>
      {trip.isPending && <p className="note-card">Loading…</p>}
      {trip.isError && (
        <>
          <p role="alert">The trip could not be loaded.</p>
          <button type="button" onClick={() => void trip.refetch()}>
            Retry
          </button>
        </>
      )}
      {/* One line that stays mounted, polite, so a start or an end is
          announced as the confirmation it is (NFR-USE-010); the controls
          below it stay out of the live region. */}
      <p aria-live="polite">{trip.isSuccess ? tripSummary(unit, trip.data) : ""}</p>
      {trip.isSuccess &&
        unit.unitKind !== "TRAILER" &&
        (trip.data.trip !== null ? (
          <OnTrip trip={trip.data.trip} />
        ) : (
          <StartTripFormFor unit={unit} />
        ))}
    </section>
  );
}

function tripSummary(unit: Unit, state: UnitTrip): string {
  if (unit.unitKind === "TRAILER") {
    if (state.pulledBy === null) return "Free.";
    return state.trip !== null
      ? `Pulled by ${state.pulledBy.fleetNumber}, on ${state.trip.driver.displayName}'s trip.`
      : `Pulled by ${state.pulledBy.fleetNumber}, not on a trip.`;
  }
  return state.trip !== null ? `Driver: ${state.trip.driver.displayName}` : "Not on a trip.";
}

function OnTrip({ trip }: { trip: Trip }) {
  const canAssign = useCan("ManageAssignments");
  const asInstant = useTenantInstant();
  const tenantKey = getDevTenantId() ?? "default";
  const end = useFormMutation({
    mutate: () => endTrip(trip.id),
    invalidate: tripWriteKeys(tenantKey),
  });

  return (
    <>
      <p>
        Started {asInstant(trip.startedAt)}
        {trip.startedBy !== null ? ` by ${trip.startedBy.displayName}` : ""}
      </p>
      <p>
        {trip.trailers.length > 0
          ? `Towing ${trip.trailers.map((t) => t.fleetNumber).join(", ")}`
          : "Towing nothing."}
      </p>
      {canAssign && (
        <button
          className="btn-primary"
          type="button"
          disabled={end.isPending}
          onClick={() => end.submit(undefined)}
        >
          {end.isPending ? "Ending…" : "End trip"}
        </button>
      )}
      {end.error !== null && <p role="alert">{refusalMessage(end.error, TRIP_WORDING)}</p>}
    </>
  );
}

function StartTripFormFor({ unit }: { unit: Unit }) {
  const canAssign = useCan("ManageAssignments");
  return canAssign ? <StartTripForm unit={unit} /> : null;
}

function StartTripForm({ unit }: { unit: Unit }) {
  const tenantKey = getDevTenantId() ?? "default";
  const asDate = useTenantDate();
  // fetchVehicles' read, made here through apiGet, which the entry already
  // carries: importing api/vehicles would add a preload of its chunk to this
  // lazy route's map in the capture entry (web/CLAUDE.md, The design system).
  const vehicles = useQuery({
    queryKey: vehiclesKey(tenantKey),
    queryFn: () => apiGet<Vehicle[]>("/api/vehicles"),
  });
  // Same read and key UnitDetail makes, so the screen asks once.
  const rigs = useQuery({ queryKey: rigsKey(tenantKey), queryFn: () => fetchRigs() });
  const [driverId, setDriverId] = useState("");
  const [pick, setPick] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const blockers = useQuery({
    queryKey: tripBlockersKey(unit.id, added),
    queryFn: () => fetchTripBlockers(unit.id, added),
  });

  const start = useFormMutation({
    mutate: (body: NewTrip) => startTrip(body),
    invalidate: tripWriteKeys(tenantKey),
    onSuccess: () => {
      setDriverId("");
      setAdded([]);
    },
  });

  const openRigs = (rigs.data ?? []).filter((r) => r.effectiveTo === null);
  const ownRig = openRigs.find((r) => r.motiveVehicleId === unit.id);
  const coupled = ownRig?.members.filter((m) => m.vehicleId !== unit.id) ?? [];
  // Which open rig, headed elsewhere, holds each towed unit: such a trailer
  // is shown but not selectable, naming its truck (spec, decision 4).
  const heldBy = new Map<string, string>();
  for (const r of openRigs) {
    if (r.motiveVehicleId === unit.id) continue;
    for (const m of r.members) {
      if (m.vehicleId !== r.motiveVehicleId) heldBy.set(m.vehicleId, r.motiveFleetNumber);
    }
  }
  const coupledIds = new Set(coupled.map((m) => m.vehicleId));
  const fleetOf = new Map((vehicles.data ?? []).map((v) => [v.id, v.fleetNumber]));
  const offered = (vehicles.data ?? [])
    .filter(
      (v) =>
        v.unitKind === "TRAILER" &&
        !RETIRED.has(v.status) &&
        !coupledIds.has(v.id) &&
        !added.includes(v.id),
    )
    .sort((a, b) => byNaturalCode(a.fleetNumber, b.fleetNumber));
  const blocking = blockers.data ?? [];

  function addTrailer() {
    if (pick === "" || heldBy.has(pick)) return;
    setAdded([...added, pick]);
    setPick("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (driverId === "") return;
    start.submit({ motiveVehicleId: unit.id, driverUserId: driverId, addTrailers: added });
  }

  // The due inspections sit between the form and its Start button, and each
  // carries a nominate form of its own, which may not nest inside this one;
  // Start joins the form by its id.
  return (
    <>
      <form id="trip-start" onSubmit={submit}>
        <div className="tyres-row-form">
          <DriverPicker
            id="tripDriver"
            label="Driver"
            value={driverId}
            onChange={setDriverId}
            placeholder="Choose…"
          />
        </div>
        {coupled.length > 0 && (
          <p className="tyres-receive-hint">
            Coupled now: {coupled.map((m) => m.fleetNumber).join(", ")}
          </p>
        )}

        <div className="tyres-row-form">
          <label htmlFor="tripTrailer">Add a trailer</label>
          <select id="tripTrailer" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose…</option>
            {offered.map((v) => {
              const holder = heldBy.get(v.id);
              return (
                <option key={v.id} value={v.id} disabled={holder !== undefined}>
                  {holder !== undefined ? `${v.fleetNumber}, coupled to ${holder}` : v.fleetNumber}
                </option>
              );
            })}
          </select>
          <button type="button" onClick={addTrailer} disabled={pick === ""}>
            Add
          </button>
        </div>
        {vehicles.isError && (
          <>
            <p role="alert">The trailers could not be loaded.</p>
            <button type="button" onClick={() => void vehicles.refetch()}>
              Retry
            </button>
          </>
        )}
        {added.length > 0 && (
          <ul className="unit-rotate-rows" aria-label="Trailers to add">
            {added.map((id) => (
              <li key={id}>
                <span>{fleetOf.get(id) ?? id}</span>{" "}
                <button type="button" onClick={() => setAdded(added.filter((a) => a !== id))}>
                  Remove {fleetOf.get(id) ?? "trailer"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      {/* U148: what holds the start is shown before Start, with the
          nominate action on each task, so the block is never a surprise. */}
      {blocking.length > 0 && (
        <>
          <p>These inspections are due and must be done before the trip starts:</p>
          <ul className="unit-rotate-rows" aria-label="Due inspections">
            {blocking.map((b) => (
              <li key={b.taskId}>
                <span>
                  {b.fleetNumber}, due {asDate(b.dueAt)}
                </span>
                <NominateControl
                  taskId={b.taskId}
                  unitId={b.vehicleId}
                  label={`Driver for ${b.fleetNumber}`}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {blockers.isError && <p role="alert">The due inspections could not be checked.</p>}

      <button
        className="btn-primary"
        type="submit"
        form="trip-start"
        disabled={driverId === "" || blocking.length > 0 || start.isPending}
      >
        {start.isPending ? "Starting…" : "Start trip"}
      </button>
      {start.error !== null && <p role="alert">{refusalMessage(start.error, TRIP_WORDING)}</p>}
    </>
  );
}
