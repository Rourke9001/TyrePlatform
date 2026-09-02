import type { FitmentHistoryRow } from "../../api/units";
import { useTenantDate } from "../../time/tenantTime";
import { distanceSourceLabel, orientationLabel } from "./vocabulary";

// CR-012: a distance and its provenance are one fact, so they are rendered
// in one cell and never apart. A bare number reads as measured, which for an
// inferred one is a claim the register never made; an open fitment has run
// no distance yet and says so instead.
function distanceCell(row: FitmentHistoryRow): string {
  if (row.removedAt === null) return "Fitted";
  if (row.distanceKm === null) return distanceSourceLabel(row.distanceSource);
  return `${row.distanceKm} km (${distanceSourceLabel(row.distanceSource)})`;
}

// FR-FIT's history read, in the server's own order: most recent first is
// units.go's ORDER BY, and a second sort here would be a second opinion
// about which fitment is the latest.
export function FitmentHistory({ rows }: { rows: FitmentHistoryRow[] }) {
  const asDate = useTenantDate();

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
            <td>{row.fittedTreadMm ?? "—"}</td>
            <td>{row.removedTreadMm ?? "—"}</td>
            <td>{orientationLabel(row.mountOrientation)}</td>
            <td>{row.removalReason ?? "—"}</td>
            <td>{distanceCell(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
