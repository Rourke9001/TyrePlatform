import type { FitmentHistoryRow } from "../../api/units";
import { useTenantDate } from "../../time/tenantTime";
import { distanceSourceLabel, orientationLabel } from "./vocabulary";
import { formatCount } from "../../ui/vocabulary";
import { useUnitLabels, type UnitLabels } from "../../units/units";
import { formatTreadAge } from "../../format/treadAge";

// CR-012: a distance and its provenance are one fact, rendered in one cell.
// A bare number reads as measured, which for an inferred one is a claim
// the register never made.
function distanceCell(row: FitmentHistoryRow, units: UnitLabels): string {
  if (row.removedAt === null) return "Fitted";
  if (row.distanceKm === null) return distanceSourceLabel(row.distanceSource);
  return `${formatCount(row.distanceKm)} ${units.distance} (${distanceSourceLabel(row.distanceSource)})`;
}

// FR-TYR-017: a tread figure with its measurement's age, in its own cell.
function treadCell(treadMm: string | null, ageDays: number | null): string {
  if (treadMm === null) return "—";
  return ageDays === null ? treadMm : `${treadMm} (${formatTreadAge(ageDays)})`;
}

// FR-FIT's history read, in the server's own order: most recent first is
// units.go's ORDER BY, and a second sort here would be a second opinion
// about which fitment is the latest.
export function FitmentHistory({ rows }: { rows: FitmentHistoryRow[] }) {
  const asDate = useTenantDate();
  const labels = useUnitLabels();

  if (rows.length === 0) {
    return <p className="note-card">This unit has no fitment history yet.</p>;
  }

  return (
    <table className="tyres-table">
      <thead>
        <tr>
          <th scope="col">Tyre</th>
          <th scope="col">Position</th>
          <th scope="col">Fitted</th>
          <th scope="col">Removed</th>
          <th scope="col">Tread on</th>
          <th scope="col">Tread off</th>
          <th scope="col">Orientation</th>
          <th scope="col">Reason</th>
          <th scope="col">Distance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.fitmentId}>
            <th scope="row">{row.displayCode}</th>
            <td>{row.positionCode}</td>
            <td>{asDate(row.fittedAt)}</td>
            <td>{row.removedAt === null ? "Still fitted" : asDate(row.removedAt)}</td>
            <td>{treadCell(row.fittedTreadMm, row.fittedAgeDays)}</td>
            <td>{treadCell(row.removedTreadMm, row.removedAgeDays)}</td>
            <td>{orientationLabel(row.mountOrientation)}</td>
            <td>{row.removalReason ?? "—"}</td>
            <td>{distanceCell(row, labels)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
