import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { fetchRigs } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { fetchUnit, fetchUnitFitments } from "../../api/units";
import { useCan } from "../../auth/actorContext";
import { severityLabel } from "../../domain/vocabulary";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { PageHeader } from "../../ui/PageHeader";
import { positionStates, unitLevelExceptions } from "./condition.view";
import { FitmentHistory } from "./FitmentHistory";
import { useUnitCondition } from "./inspections.data";
import { PositionPanel } from "./PositionPanel";
import { RotateForm } from "./RotateForm";
import { ScheduleInspectionForm } from "./ScheduleInspectionForm";
import { TripPanel } from "./TripPanel";
import { UnitEditForm } from "./UnitEditForm";
import { UnitInspectionList } from "./UnitInspectionList";
import { UnitPlan } from "./UnitPlan";
import { UnitStatusForm } from "./UnitStatusForm";
import { UnitTaskList } from "./UnitTaskList";
import { rigsKey, unitFitmentsKey, unitKey } from "./queryKeys";
import "./unit.css";

// D7's unit screen: ViewFleet reads it; every form inside is ManageAssets'
// except the inspection schedule and the trip's start and end
// (ManageAssignments, U2). A reader is shown the unit rather than controls
// that would refuse them (D8, ADR-0011).
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
  const condition = useUnitCondition(unitId);

  if (unit.isPending) return <p className="unit-note">Loading…</p>;

  if (unit.isError) {
    return (
      <Banner
        tone="critical"
        title={<h2 className="unit-banner-heading">Unit didn&apos;t load</h2>}
        action={
          <Button variant="primary" onClick={() => void unit.refetch()}>
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

  const selected = unit.data.positions.find((p) => p.id === selectedPositionId) ?? null;
  // Judged by app.v_exception alone (TYRE-325 spec section 3); the plan
  // carries no condition until the read lands.
  const states = condition.isSuccess ? positionStates(unit.data, condition.data) : undefined;
  const unitRules = condition.isSuccess ? unitLevelExceptions(condition.data) : [];
  const openRig = (rigs.data ?? []).find(
    (r) => r.effectiveTo === null && r.members.some((m) => m.vehicleId === unit.data.id),
  );
  // U7 member order, as RotateForm.
  const siblings = openRig?.members.filter((m) => m.vehicleId !== unit.data.id) ?? [];

  return (
    <section className="unit-detail tr-stack" aria-labelledby="unit-heading">
      {/* The region keeps the unit's own name, so its label points inside the
          header's h1 rather than at a second copy of the fleet number. */}
      <PageHeader
        title={<span id="unit-heading">{unit.data.fleetNumber}</span>}
        description={`${unit.data.registration ?? "No registration"} · ${unit.data.configurationName}`}
      />
      {/* What this unit is coupled to decides where a rotation may send a
          casing (FR-FIT-010), so the unit screen names the rig rather than
          leaving it to be found on another screen. Only an open one: an ended
          rig is history, and naming it here would read as current. */}
      {siblings.length > 0 && (
        <p className="unit-detail-rig">
          In a rig with{" "}
          <Link to="/fleet/rigs">{siblings.map((m) => m.fleetNumber).join(", ")}</Link>
        </p>
      )}

      <div className="unit-detail-cols">
        <Card padding="md">
          <UnitPlan
            unit={unit.data}
            states={states}
            selectedId={selectedPositionId}
            onSelect={setSelectedPositionId}
          />
          {unitRules.length > 0 && (
            <ul className="unit-plan-rules" aria-label="Open exceptions on the whole unit">
              {unitRules.map((row) => (
                <li key={row.ruleCode}>{`${row.ruleName}: ${severityLabel(row.severity)}`}</li>
              ))}
            </ul>
          )}
          {condition.isError && (
            <p className="unit-plan-condition">
              <span>Condition could not be loaded.</span>{" "}
              <Button
                variant="secondary"
                aria-label="Retry the condition"
                onClick={() => void condition.refetch()}
              >
                Retry
              </Button>
            </p>
          )}
        </Card>

        {selected === null ? (
          <Card padding="md">
            <p className="unit-panel-empty">
              {canManage
                ? "Pick a position on the plan to fit or remove a tyre."
                : "Pick a position on the plan to see its tyre."}
            </p>
          </Card>
        ) : (
          // Keyed on the position so picking another one starts its panel
          // clean: a warning or a confirmation belongs to the position it was
          // raised for, and carrying it across would attach it to the wrong one.
          <PositionPanel
            key={selected.id}
            unit={unit.data}
            position={selected}
            state={states?.get(selected.id)}
            latest={condition.data?.latest?.inspection ?? null}
          />
        )}
      </div>

      <TripPanel unit={unit.data} />

      {canManage && <RotateForm unit={unit.data} />}
      {canManage && <UnitEditForm unit={unit.data} />}
      {canManage && <UnitStatusForm unit={unit.data} />}

      {canAssign && <ScheduleInspectionForm unit={unit.data} />}
      <UnitTaskList unitId={unitId} />
      <UnitInspectionList unitId={unitId} />

      <Card title="Fitment history" padding="md">
        {fitments.isPending && <p className="unit-note">Loading…</p>}
        {fitments.isError && (
          <p role="alert">The fitment history could not be loaded. Retry from the unit list.</p>
        )}
        {fitments.isSuccess && <FitmentHistory rows={fitments.data} />}
      </Card>
    </section>
  );
}
