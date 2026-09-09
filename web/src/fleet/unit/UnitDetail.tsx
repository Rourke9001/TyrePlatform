import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { fetchRigs } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { fetchUnit, fetchUnitFitments } from "../../api/units";
import { useCan } from "../../auth/actorContext";
import { FitmentHistory } from "./FitmentHistory";
import { PositionPanel } from "./PositionPanel";
import { RotateForm } from "./RotateForm";
import { ScheduleInspectionForm } from "./ScheduleInspectionForm";
import { UnitEditForm } from "./UnitEditForm";
import { UnitPlan } from "./UnitPlan";
import { UnitStatusForm } from "./UnitStatusForm";
import { UnitTaskList } from "./UnitTaskList";
import { rigsKey, unitFitmentsKey, unitKey } from "./queryKeys";
import "../fleet.css";

// D7's unit screen: the plan view of what the unit carries, the panel for
// whichever position is picked, and the writes a controller holds. ViewFleet
// is enough to read it; every form inside is ManageAssets' except the
// inspection schedule, which is ManageAssignments' (spec U2). A reader is
// shown the unit rather than controls that would refuse them (D8, ADR-0011).
export function UnitDetail({ unitId }: { unitId: string }) {
  const canManage = useCan("ManageAssets");
  const canAssign = useCan("ManageAssignments");
  const tenantKey = getDevTenantId() ?? "default";
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);

  const unit = useQuery({ queryKey: unitKey(unitId), queryFn: () => fetchUnit(unitId) });
  // Same read RotateForm makes under rigsKey, narrowed here for the reason
  // given there.
  const rigs = useQuery({ queryKey: rigsKey(tenantKey), queryFn: () => fetchRigs() });
  const fitments = useQuery({
    queryKey: unitFitmentsKey(unitId),
    queryFn: () => fetchUnitFitments(unitId),
  });

  if (unit.isPending) return <p className="note-card">Loading…</p>;

  if (unit.isError) {
    return (
      <div className="note-card" role="alert">
        <h2>Unit didn&apos;t load</h2>
        <p>The server could not be reached. Check your connection, then retry.</p>
        <button className="btn-primary" type="button" onClick={() => void unit.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const selected = unit.data.positions.find((p) => p.id === selectedPositionId) ?? null;
  const openRig = (rigs.data ?? []).find(
    (r) => r.effectiveTo === null && r.members.some((m) => m.vehicleId === unit.data.id),
  );
  // U7 member order, as RotateForm.
  const siblings = openRig?.members.filter((m) => m.vehicleId !== unit.data.id) ?? [];

  return (
    <section className="unit-detail" aria-labelledby="unit-heading">
      <h1 className="page-title" id="unit-heading">
        {unit.data.fleetNumber}
      </h1>
      <p className="unit-detail-sub">
        {unit.data.registration ?? "No registration"} · {unit.data.configurationName}
      </p>
      {/* What this unit is coupled to decides where a rotation may send a
          casing (FR-FIT-010), so the unit screen names the rig rather than
          leaving it to be found on another screen. Only an open one: an ended
          rig is history, and naming it here would read as current. */}
      {siblings.length > 0 && (
        <p className="unit-detail-sub">
          In a rig with{" "}
          <Link to="/fleet/rigs">{siblings.map((m) => m.fleetNumber).join(", ")}</Link>
        </p>
      )}

      <UnitPlan
        positions={unit.data.positions}
        selectedId={selectedPositionId}
        onSelect={setSelectedPositionId}
      />

      {selected === null ? (
        <p className="unit-panel-empty">Pick a position on the plan to fit or remove a tyre.</p>
      ) : (
        // Keyed on the position so picking another one starts its panel
        // clean: a warning or a confirmation belongs to the position it was
        // raised for, and carrying it across would attach it to the wrong one.
        <PositionPanel key={selected.id} unit={unit.data} position={selected} />
      )}

      {canManage && <RotateForm unit={unit.data} />}
      {canManage && <UnitEditForm unit={unit.data} />}
      {canManage && <UnitStatusForm unit={unit.data} />}

      {canAssign && <ScheduleInspectionForm unit={unit.data} />}
      <UnitTaskList unitId={unitId} />

      <h2>Fitment history</h2>
      {fitments.isPending && <p className="note-card">Loading…</p>}
      {fitments.isError && (
        <p role="alert">The fitment history could not be loaded. Retry from the unit list.</p>
      )}
      {fitments.isSuccess && <FitmentHistory rows={fitments.data} />}
    </section>
  );
}
