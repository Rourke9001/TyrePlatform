import type { FitmentHistoryRow, OpenFitment, Unit, UnitPosition } from "../../api/units";
import type { UnitTrip } from "../../api/trips";
import { treadSourceLabel } from "../../domain/vocabulary";
import { formatCount, formatMm } from "../../format/numbers";
import { formatTreadAge } from "../../format/treadAge";
import type { DiagramPosition, DiagramUnit } from "../../ui/AxleDiagram";
import type { UnitLabels } from "../../units/units";
import { distanceSourceLabel } from "./vocabulary";

// The vehicle screen's view model (ADR-0022): pure functions from the unit
// wire to what the screen shows, tested without React.

// NFR-USE-009: occupancy in words, so the plan never says it in colour alone.
export function occupantOf(position: UnitPosition): string {
  return position.fitment?.displayCode ?? "empty";
}

// NFR-PRO-001: a depth and where it came from are one fact, rendered in one
// cell as the history renders a distance (TYRE-324).
export function lastTreadCell(fitment: OpenFitment): string {
  if (fitment.lastTreadMm === null) return "—";
  const mm = formatMm(Number(fitment.lastTreadMm));
  if (fitment.lastTreadSource === null) return mm;
  // FR-TYR-017: the measurement's age, with its source.
  const age =
    fitment.lastTreadAgeDays === null ? "" : `, ${formatTreadAge(fitment.lastTreadAgeDays)}`;
  return `${mm} (${treadSourceLabel(fitment.lastTreadSource)}${age})`;
}

// CR-012: a distance and its provenance are one fact, rendered in one cell.
// A bare number reads as measured, which for an inferred one is a claim
// the register never made.
export function distanceCell(row: FitmentHistoryRow, units: UnitLabels): string {
  if (row.removedAt === null) return "Fitted";
  if (row.distanceKm === null) return distanceSourceLabel(row.distanceSource);
  return `${formatCount(row.distanceKm)} ${units.distance} (${distanceSourceLabel(row.distanceSource)})`;
}

// FR-TYR-017: a tread figure with its measurement's age, in its own cell.
export function treadCell(treadMm: string | null, ageDays: number | null): string {
  if (treadMm === null) return "—";
  return ageDays === null ? treadMm : `${treadMm} (${formatTreadAge(ageDays)})`;
}

// A trailer and a motive between trips both read as no trip and no motive,
// so which sentence applies comes from the unit's own kind.
export function tripSummary(unit: Unit, state: UnitTrip): string {
  if (unit.unitKind === "TRAILER") {
    if (state.pulledBy === null) return "Free.";
    return state.trip !== null
      ? `Pulled by ${state.pulledBy.fleetNumber}, on ${state.trip.driver.displayName}'s trip.`
      : `Pulled by ${state.pulledBy.fleetNumber}, not on a trip.`;
  }
  return state.trip !== null ? `Driver: ${state.trip.driver.displayName}` : "Not on a trip.";
}

// BR-VEH-001, plan view nose up: the left side from the outside in, then the
// right from the inside out. AxleDiagram draws an axle's first half left of
// the beam, so this order is what puts each tyre on its own side. Side and
// slot are the wire's (unitPositionJSON); nothing here derives them.
function acrossVehicle(position: UnitPosition): number {
  const depth = position.slot === "OUTER" ? 2 : 1;
  return position.side === "RIGHT" ? depth : -depth;
}

function tile(position: UnitPosition): DiagramPosition {
  const occupant = occupantOf(position);
  // No condition, since the unit wire carries none, and never `empty`: an
  // empty position is the one a tyre is fitted to, so it stays a button.
  return {
    id: position.id,
    label: position.code,
    valueText: occupant,
    ariaLabel: `Position ${position.code}: ${occupant}`,
    dataPositionId: position.id,
  };
}

// Axles ascending, whatever the read happened to contain: a unit with axles
// 1 and 3 still draws two axles, not a gap where axle 2 is not.
export function diagramUnit(unit: Unit): DiagramUnit {
  const mounted = unit.positions.filter((p) => !p.isSpare);
  const axleNumbers = [...new Set(mounted.map((p) => p.axleNumber ?? 0))].sort((a, b) => a - b);
  return {
    id: unit.id,
    unitHeading: unit.fleetNumber,
    axles: axleNumbers.map((axleNumber) => ({
      id: `axle-${axleNumber}`,
      positions: mounted
        .filter((p) => (p.axleNumber ?? 0) === axleNumber)
        .sort((a, b) => acrossVehicle(a) - acrossVehicle(b) || a.sequence - b.sequence)
        .map(tile),
    })),
    spares: unit.positions.filter((p) => p.isSpare).map(tile),
  };
}
