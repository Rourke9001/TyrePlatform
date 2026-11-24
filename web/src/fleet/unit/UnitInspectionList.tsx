import { Link, useNavigate } from "react-router";

import type { UnitInspection } from "../../api/inspections";
import { inspectionMarkLabel } from "../../domain/vocabulary";
import { formatCount } from "../../format/numbers";
import { useTenantInstant } from "../../time/tenantTime";
import { Badge } from "../../ui/Badge";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { DataTable, type Column } from "../../ui/DataTable";
import { EmptyState } from "../../ui/EmptyState";
import { useUnitLabels } from "../../units/units";
import { inspectionMark, odometerCell, voidedText } from "./inspection.view";
import { useUnitInspections } from "./inspections.data";

// A unit's inspections, newest first, voided ones marked with who, when and
// why (TYRE-325 spec section 3, U248). A row opens the inspection's page.
export function UnitInspectionList({ unitId }: { unitId: string }) {
  const asInstant = useTenantInstant();
  const units = useUnitLabels();
  const navigate = useNavigate();
  const list = useUnitInspections(unitId);
  const pathOf = (row: UnitInspection) => `/fleet/units/${unitId}/inspections/${row.inspectionId}`;

  const columns: Column<UnitInspection>[] = [
    {
      key: "when",
      header: "When",
      rowHeader: true,
      nowrap: true,
      render: (row) => <Link to={pathOf(row)}>{asInstant(row.submittedAt)}</Link>,
    },
    { key: "driver", header: "Driver", render: (row) => row.driver.displayName },
    {
      key: "odometer",
      header: "Odometer",
      render: (row) => odometerCell(row, units.distance),
    },
    {
      key: "positions",
      header: "Positions read",
      align: "right",
      render: (row) => formatCount(row.positionsRead),
    },
    {
      key: "warnings",
      header: "Warnings",
      align: "right",
      render: (row) => formatCount(row.warningCount),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => {
        const mark = inspectionMark(row);
        if (mark === null) return "—";
        return (
          <span className="unit-inspection-status">
            <Badge>{inspectionMarkLabel(mark)}</Badge>
            {mark === "voided" && (
              <span className="unit-note">
                {voidedText(row, row.voidedAt === null ? null : asInstant(row.voidedAt))}
              </span>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <Card title="Inspections" padding="md">
      {list.isPending && <p className="unit-note">Loading…</p>}

      {list.isError && (
        <Banner
          tone="critical"
          title="The inspections could not be loaded."
          action={
            <Button variant="primary" onClick={() => void list.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {list.isSuccess && (
        <>
          <DataTable
            caption="Inspections"
            columns={columns}
            rows={list.data.pages.flatMap((page) => page.inspections)}
            rowKey={(row) => row.inspectionId}
            onRowClick={(row) => void navigate(pathOf(row))}
            empty={<EmptyState className="unit-empty" title="No inspections yet." />}
          />
          {list.hasNextPage && (
            <div className="unit-inspection-more">
              <Button
                variant="secondary"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                Show older inspections
              </Button>
              {list.isFetchNextPageError && (
                <p role="alert" className="unit-note">
                  Older inspections could not be loaded.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
