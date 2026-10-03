import { Link } from "react-router";

import type { DashboardBody } from "../api/dashboard";
import { moneyOrEmpty, type Money } from "../api/money";
import { Panel } from "../ui/Panel";
import { ProvenanceSplit } from "../ui/ProvenanceSplit";
import { SeverityBadge } from "../ui/SeverityBadge";
import { StatTile } from "../ui/StatTile";
import {
  absenceLabel,
  formatCount,
  judgedAtLabel,
  plural,
  pluralWord,
  SEVERITY_CODES,
  severityLabel,
} from "../ui/vocabulary";
import { withDepot } from "./dashboardParams";

export function DashboardTiles({ body, depot }: { body: DashboardBody; depot?: string }) {
  const { exceptions, belowThreshold, estate, units, moneyVisible } = body;
  const severities = SEVERITY_CODES.filter((s) => s in exceptions.bySeverity).concat(
    Object.keys(exceptions.bySeverity).filter((s) => !SEVERITY_CODES.includes(s)),
  );
  const estateMoney = (value: Money | null) =>
    moneyOrEmpty(value, moneyVisible, estate.tyreCount, absenceLabel("noTyres"));
  // U44: an empty estate's total line is the absence alone; "across 0
  // tyres" would only restate it.
  const estateEmpty = moneyVisible && estate.tyreCount === 0;
  // U44, 000049: the total is a partial sum when one side has no valued
  // member, so it discloses both sides' unvalued counts when either is not 0.
  const partial =
    estate.unvaluedCount > 0 || estate.casingUnvaluedCount > 0
      ? `; tread ${formatCount(estate.unvaluedCount)} of ${formatCount(estate.tyreCount)} unvalued, casing ${formatCount(estate.casingUnvaluedCount)} of ${formatCount(estate.tyreCount)} unvalued`
      : "";

  return (
    <>
      {/* FR-DSH-002: tread and casing, each with its own provenance split.
          The casing partitions are the view's four disjoint counts (U27). */}
      {/* U48: estateRowJSON carries no judgedAt; loadEstate values the
          estate as at today, so the page names that clock itself. */}
      <Panel id="estate-panel" title="Estate value" judged={judgedAtLabel("TODAY")}>
        <div className="tile-grid">
          <StatTile
            label="Tread value"
            value={estateMoney(estate.treadValue)}
            qualifier={
              <>
                {formatCount(estate.unvaluedCount)} of {formatCount(estate.tyreCount)} unvalued
                <ProvenanceSplit
                  caption="Tread value provenance"
                  segments={[
                    { key: "actual", label: "Actual", count: estate.actualCount },
                    { key: "estimated", label: "Estimated", count: estate.estimatedCount },
                    { key: "unvalued", label: "Unvalued", count: estate.unvaluedCount },
                  ]}
                />
              </>
            }
            requirement="FR-DSH-002"
          />
          <StatTile
            label="Casing value"
            value={estateMoney(estate.casingValue)}
            qualifier={
              <>
                {formatCount(estate.casingUnvaluedCount)} of {formatCount(estate.tyreCount)}{" "}
                unvalued
                <ProvenanceSplit
                  caption="Casing value provenance"
                  segments={[
                    { key: "actual", label: "Actual", count: estate.casingActualCount },
                    { key: "estimated", label: "Estimated", count: estate.casingEstimatedCount },
                    { key: "audit", label: "Audit", count: estate.casingAuditCount },
                    { key: "unvalued", label: "Unvalued", count: estate.casingUnvaluedCount },
                  ]}
                />
              </>
            }
          />
        </div>
        <p className="clock-note">
          {estateEmpty
            ? `${absenceLabel("noTyres")}.`
            : `${estateMoney(estate.totalValue)} across ${plural(estate.tyreCount, "tyre", "tyres")} in total${partial}.`}
        </p>
      </Panel>

      {/* U18: FR-DSH-003 counts v_exception rows and FR-DSH-004 is the
          register's count, judged at different clocks; the note says so,
          since on a fixture they agree and after a policy change they will
          not. */}
      <Panel id="exceptions-panel" title="Exceptions">
        <div className="tile-grid">
          <StatTile
            label="Open exceptions"
            value={formatCount(exceptions.open)}
            qualifier={
              <>
                {plural(exceptions.urgent, "urgent", "urgent")};{" "}
                {plural(exceptions.rulesConfigured, "rule configured", "rules configured")}
                <ul className="severity-lines">
                  {severities.map((s) => (
                    <li key={s}>
                      <SeverityBadge severity={s} />
                      <Link to={withDepot(`/exceptions?severity=${encodeURIComponent(s)}`, depot)}>
                        {severityLabel(s)} {formatCount(exceptions.bySeverity[s])}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            }
            judged={judgedAtLabel(exceptions.judgedAt)}
            to={withDepot("/exceptions", depot)}
            requirement="FR-DSH-003"
            tone={exceptions.urgent > 0 ? "critical" : "default"}
          />
          <StatTile
            label="Below the removal threshold"
            value={formatCount(belowThreshold.running)}
            qualifier={`${pluralWord(belowThreshold.running, "running position", "running positions")}; ${plural(belowThreshold.spare, "spare", "spares")} disclosed separately`}
            judged={judgedAtLabel(belowThreshold.judgedAt)}
            to={moneyVisible ? withDepot("/at-risk", depot) : undefined}
            linkLabel="See the at-risk list"
            requirement="FR-DSH-004"
            tone={belowThreshold.running > 0 ? "critical" : "default"}
          />
        </div>
        <p className="clock-note">
          Exceptions are judged at each unit's latest inspection; the threshold count is judged
          today against the policy in force now.
        </p>
      </Panel>

      {/* FR-DSH-005, 006; FR-EXC-026, 027, 029: four tiles on the tenant's
          calendar day. Unscheduled and unknown are disclosed, never folded
          into the covered figure. */}
      <Panel id="units-panel" title="Units" judged={judgedAtLabel(units.judgedAt)}>
        <div className="tile-grid">
          <StatTile
            label="Inspection coverage"
            value={`${formatCount(units.covered)} of ${formatCount(units.total)}`}
            qualifier={`${formatCount(units.scheduled)} scheduled, ${formatCount(units.unscheduled)} unscheduled`}
            requirement="FR-DSH-005"
          />
          <StatTile
            label="Overdue tasks"
            value={formatCount(body.overdueTasks)}
            requirement="FR-DSH-006"
            tone={body.overdueTasks > 0 ? "warning" : "default"}
          />
          <StatTile
            label="Stale units"
            value={formatCount(units.stale)}
            qualifier={
              units.staleUnknown > 0
                ? `${formatCount(units.staleUnknown)} unknown, never inspected`
                : undefined
            }
            requirement="FR-EXC-027"
            tone={units.stale > 0 ? "warning" : "default"}
          />
          {/* U17: /fleet/rigs cannot narrow to a depot, so a depot view
              offers no link to a list that counts every depot. */}
          <StatTile
            label="Unreconciled rig reports"
            value={formatCount(body.pendingCompositionReports)}
            to={depot ? undefined : "/fleet/rigs"}
            linkLabel="See the rigs"
            requirement="FR-EXC-029"
            tone={body.pendingCompositionReports > 0 ? "warning" : "default"}
          />
        </div>
      </Panel>
    </>
  );
}
