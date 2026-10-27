import type { FitmentHistoryRow } from "../../api/units";
import { useTenantDate } from "../../time/tenantTime";
import { EmptyState } from "../../ui/EmptyState";
import { TyreIcon } from "../../ui/icons/Tyre";
import { useUnitLabels } from "../../units/units";
import { distanceCell, treadCell } from "./unit.view";
import { orientationLabel } from "./vocabulary";

// FR-FIT's history read, in the server's own order: most recent first is
// units.go's ORDER BY, and a second sort here would be a second opinion
// about which fitment is the latest.
export function FitmentHistory({ rows }: { rows: FitmentHistoryRow[] }) {
  const asDate = useTenantDate();
  const labels = useUnitLabels();

  if (rows.length === 0) {
    return (
      <EmptyState
        className="unit-empty"
        icon={TyreIcon}
        title="This unit has no fitment history yet."
      />
    );
  }

  // A native table, not DataTable, which draws no row header: the tyre
  // heads each row.
  return (
    <div className="unit-table-wrap">
      <table className="unit-table">
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
    </div>
  );
}
