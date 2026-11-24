import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { ApiError } from "../../api/apiError";
import type { InspectionDetail, InspectionWarning } from "../../api/inspections";
import { inspectionWarningLabel, warningResponseLabel } from "../../domain/vocabulary";
import { formatMm, plural } from "../../format/numbers";
import { useTenantInstant } from "../../time/tenantTime";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { DataTable, type Column } from "../../ui/DataTable";
import { EmptyState } from "../../ui/EmptyState";
import { KeyValue } from "../../ui/KeyValue";
import { PageHeader } from "../../ui/PageHeader";
import { TreadReadings } from "../../ui/TreadReadings";
import { useUnitLabels } from "../../units/units";
import {
  inspectionMark,
  inspectionRows,
  odometerCell,
  pressureText,
  readingCells,
  voidedText,
  warningValueText,
  type InspectionRow,
} from "./inspection.view";
import { useCan } from "../../auth/actorContext";
import { useUnitInspection } from "./inspections.data";
import { VoidInspectionDialog } from "./VoidInspectionDialog";
import "./unit.css";

// One inspection as it concerns one unit (TYRE-325 spec section 4): what was
// read, the target in force that day and the warnings the driver saw. No
// condition is drawn here: only the latest inspection is judged, and the
// unit screen shows that (U18).
export function InspectionPage({ unitId, inspectionId }: { unitId: string; inspectionId: string }) {
  const read = useUnitInspection(unitId, inspectionId);
  // NFR-USE-010: the void's success is said, held here so it outlasts the
  // dialog and the page's own refetch.
  const [status, setStatus] = useState("");

  if (read.isPending) return <p className="unit-note">Loading…</p>;

  // A 404 answers the same next time, so it stands over a copy in hand.
  if (read.error instanceof ApiError && read.error.status === 404) {
    return (
      <EmptyState
        headingLevel={2}
        title="This inspection is not on this unit."
        action={<Link to={`/fleet/units/${unitId}`}>Back to the unit</Link>}
      />
    );
  }

  // Any other failed refresh keeps the copy in hand, with a notice, as the
  // inspection list keeps its rows (web/CLAUDE.md, The network).
  if (read.data === undefined) {
    return (
      <Banner
        tone="critical"
        title={<h2 className="unit-banner-heading">Inspection didn&apos;t load</h2>}
        action={
          <Button variant="primary" onClick={() => void read.refetch()}>
            Retry
          </Button>
        }
      >
        <p className="unit-banner-body">
          The server could not be reached. Check your connection, then retry.
        </p>
      </Banner>
    );
  }

  return (
    <InspectionBody
      unitId={unitId}
      detail={read.data}
      status={status}
      refreshFailed={read.isError}
      onRetry={() => void read.refetch()}
      onVoided={() => {
        setStatus(
          "Inspection voided. Its readings no longer count toward condition or exceptions.",
        );
      }}
    />
  );
}

type KeyedWarning = InspectionWarning & { key: string };

function InspectionBody({
  unitId,
  detail,
  status,
  refreshFailed,
  onRetry,
  onVoided,
}: {
  unitId: string;
  detail: InspectionDetail;
  status: string;
  refreshFailed: boolean;
  onRetry: () => void;
  onVoided: () => void;
}) {
  const canVoid = useCan("VoidInspection");
  // Each opening is a fresh dialog, so a reason or a refusal from the last
  // one is not carried into the next.
  const [voiding, setVoiding] = useState(false);
  const [openings, setOpenings] = useState(0);
  const asInstant = useTenantInstant();
  const units = useUnitLabels();
  const row = detail.inspection;
  const mark = inspectionMark(row);
  // WCAG 2.4.3: a void, ours landing or one read back after a TY019 refusal,
  // removes the button the dialog hands focus back to, before the dialog
  // closes or after. Once it is closed, focus left on nothing goes to the
  // heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const offered = useRef(false);
  useEffect(() => {
    if (voiding || !offered.current || mark !== "voided") return;
    offered.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) heading.current?.focus();
  }, [voiding, mark]);
  const when = asInstant(row.submittedAt);
  const others = detail.units.filter((u) => u.fleetNumber !== row.fleetNumber);

  // The wire carries no warning id, and a submit stamps every warning with
  // one instant, so a row is keyed by its place in the server's order.
  const warnings = detail.warnings.map((w, i) => ({ ...w, key: String(i) }));
  const warningColumns: Column<KeyedWarning>[] = [
    {
      key: "warning",
      header: "Warning",
      rowHeader: true,
      render: (w) => inspectionWarningLabel(w.code),
    },
    {
      key: "position",
      header: "Position",
      nowrap: true,
      render: (w) => w.positionCode ?? "Whole unit",
    },
    { key: "value", header: "Value entered", render: (w) => warningValueText(w, units) ?? "—" },
    {
      key: "response",
      header: "Driver's response",
      render: (w) => warningResponseLabel(w.response),
    },
  ];

  const readingColumns: Column<InspectionRow>[] = [
    {
      key: "position",
      header: "Position",
      rowHeader: true,
      nowrap: true,
      render: (r) => (r.kind === "reading" ? r.reading.positionCode : r.spare.positionCode),
    },
    {
      key: "tyre",
      header: "Tyre",
      mono: true,
      render: (r) => (r.kind === "reading" ? (r.reading.displayCode ?? "Not on record") : "—"),
    },
    {
      key: "readings",
      header: "Readings",
      render: (r) => {
        if (r.kind === "absent") return "Reported absent";
        if (r.reading.treadsMm.length === 0) return "No tread entered";
        return <TreadReadings {...readingCells(r.reading)} governingText="Lowest" />;
      },
    },
    {
      key: "lowest",
      header: "Lowest",
      align: "right",
      nowrap: true,
      render: (r) =>
        r.kind === "reading" && r.reading.governingTreadMm !== null
          ? formatMm(r.reading.governingTreadMm)
          : "—",
    },
    {
      key: "pressure",
      header: "Pressure",
      render: (r) => (r.kind === "reading" ? pressureText(r.reading, units.pressure) : "—"),
    },
    {
      key: "damage",
      header: "Damage",
      render: (r) =>
        r.kind === "reading" && r.reading.damageFlag
          ? (r.reading.damageType ?? "Damage noted")
          : "None",
    },
    {
      key: "note",
      header: "Note",
      render: (r) => (r.kind === "reading" ? (r.reading.note ?? "—") : "—"),
    },
  ];

  const standing =
    mark === "latest" ? "Latest inspection" : mark === "voided" ? "Voided" : "Not the latest";

  return (
    <section className="unit-detail tr-stack" aria-labelledby="inspection-heading">
      <PageHeader
        back={{ label: `Back to ${row.fleetNumber}`, to: `/fleet/units/${unitId}` }}
        headingRef={heading}
        title={<span id="inspection-heading">{`Inspection of ${row.fleetNumber}`}</span>}
        description={`${plural(row.positionsRead, "position", "positions")} read on this unit`}
        actions={
          canVoid && mark !== "voided" ? (
            <Button
              variant="danger"
              onClick={() => {
                offered.current = true;
                setOpenings((n) => n + 1);
                setVoiding(true);
              }}
            >
              Void inspection
            </Button>
          ) : undefined
        }
      />
      {/* Mounted empty so it speaks when the void lands, and hidden until
          then so it takes no room in the stack. */}
      <p role="status" className={status === "" ? "tr-vh" : "unit-note"}>
        {status}
      </p>
      {refreshFailed && (
        <Banner
          tone="warning"
          title="This inspection couldn't be refreshed"
          action={
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          What&apos;s shown may be out of date. Check your connection, then retry.
        </Banner>
      )}
      <VoidInspectionDialog
        key={openings}
        open={voiding}
        onClose={() => {
          setVoiding(false);
        }}
        inspection={row}
        units={detail.units}
        when={when}
        onVoided={() => {
          setVoiding(false);
          onVoided();
        }}
      />

      {mark === "voided" && (
        <Banner tone="info" title="Voided">
          {voidedText(row, row.voidedAt === null ? null : asInstant(row.voidedAt))}
        </Banner>
      )}

      <Card padding="md">
        <KeyValue
          columns={3}
          items={[
            { label: "When", value: when },
            { label: "Driver", value: row.driver.displayName },
            { label: "Odometer", value: odometerCell(row, units.distance) },
            { label: "Status", value: standing },
          ]}
        />
      </Card>

      {(row.comment !== null || row.defectReport !== null) && (
        <Card title="Driver's notes" padding="md">
          <KeyValue
            columns={2}
            items={[
              ...(row.comment === null ? [] : [{ label: "Comment", value: row.comment }]),
              ...(row.defectReport === null
                ? []
                : [{ label: "Defect report", value: row.defectReport }]),
            ]}
          />
        </Card>
      )}

      {others.length > 0 && (
        <Card title="Read with" padding="md">
          <ul className="unit-inspection-units">
            {others.map((u) => (
              <li key={u.fleetNumber}>
                {u.vehicleId !== null && u.inScope ? (
                  <Link to={`/fleet/units/${u.vehicleId}/inspections/${row.inspectionId}`}>
                    {u.fleetNumber}
                  </Link>
                ) : (
                  u.fleetNumber
                )}
                {u.addressed ? " (the unit the inspection was started on)" : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Warnings" padding="md">
        <DataTable
          caption="Warnings recorded"
          columns={warningColumns}
          rows={warnings}
          rowKey={(w) => w.key}
          empty={<EmptyState className="unit-empty" title="No warnings were recorded." />}
        />
      </Card>

      <Card title="Readings" padding="md">
        <DataTable
          caption="Readings by position"
          columns={readingColumns}
          rows={inspectionRows(detail)}
          rowKey={(r) => (r.kind === "reading" ? r.reading.positionId : r.spare.positionId)}
          empty={<EmptyState className="unit-empty" title="No positions were read on this unit." />}
        />
      </Card>
    </section>
  );
}
