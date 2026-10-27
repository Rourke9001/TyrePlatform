import { Link } from "react-router";

import type { DashboardBody } from "../api/dashboard";
import { Card } from "../ui/Card";
import { Icon } from "../ui/Icon";
import { AlertIcon } from "../ui/icons/Alert";
import { ClockIcon } from "../ui/icons/Clock";
import { Metric } from "../ui/Metric";
import { ProvenanceBar } from "../ui/ProvenanceBar";
import { tilesView } from "./dashboard.view";
import { ExceptionSeverity } from "./ExceptionSeverity";
import { useMoneyText } from "./useMoneyText";

export function DashboardTiles({ body, depot }: { body: DashboardBody; depot?: string }) {
  const { estate, exceptions, below, units } = tilesView(body, depot);
  const money = useMoneyText();

  return (
    <>
      {/* FR-DSH-002: tread and casing, each with its own provenance split. */}
      <Card title="Estate value" description={estate.judged} className="overview-wide">
        <div className="tile-grid">
          <Metric
            label="Tread value"
            value={money.figure(estate.tread.value)}
            detail={estate.tread.unvalued}
            data-requirement="FR-DSH-002"
          >
            <ProvenanceBar caption="Tread value provenance" segments={estate.tread.segments} />
          </Metric>
          <Metric
            label="Casing value"
            value={money.figure(estate.casing.value)}
            detail={estate.casing.unvalued}
          >
            <ProvenanceBar caption="Casing value provenance" segments={estate.casing.segments} />
          </Metric>
        </div>
        <p className="clock-note">{money.line(estate.total)}</p>
      </Card>

      {/* U18: FR-DSH-003 counts v_exception rows and FR-DSH-004 is the
          register's count, judged at different clocks; the note says so,
          since on a fixture they agree and after a policy change they will
          not. */}
      <Card title="Exceptions">
        <div className="tile-grid">
          <Metric
            icon={<Icon icon={AlertIcon} />}
            label="Open exceptions"
            value={exceptions.value}
            tone={exceptions.tone}
            detail={
              <>
                {exceptions.detail}
                <ul className="severity-lines">
                  {exceptions.severities.map((s) => (
                    <li key={s.code}>
                      <ExceptionSeverity code={s.code} />
                      <Link to={s.to}>{s.text}</Link>
                    </li>
                  ))}
                </ul>
              </>
            }
            link={exceptions.link}
            data-requirement="FR-DSH-003"
          >
            <p className="tile-judged">{exceptions.judged}</p>
          </Metric>
          <Metric
            label="Below the removal threshold"
            value={below.value}
            tone={below.tone}
            detail={below.detail}
            link={below.link}
            data-requirement="FR-DSH-004"
          >
            <p className="tile-judged">{below.judged}</p>
          </Metric>
        </div>
        <p className="clock-note">
          Exceptions are judged at each unit's latest inspection; the threshold count is judged
          today against the policy in force now.
        </p>
      </Card>

      {/* FR-DSH-005, 006; FR-EXC-026, 027, 029: four tiles on the tenant's
          calendar day. */}
      <Card title="Units" description={units.judged}>
        <div className="tile-grid">
          <Metric
            icon={<Icon icon={ClockIcon} />}
            label="Inspection coverage"
            value={units.coverage.value}
            detail={units.coverage.detail}
            data-requirement="FR-DSH-005"
          />
          <Metric
            label="Overdue tasks"
            value={units.overdue.value}
            tone={units.overdue.tone}
            data-requirement="FR-DSH-006"
          />
          <Metric
            label="Stale units"
            value={units.stale.value}
            tone={units.stale.tone}
            detail={units.stale.detail}
            data-requirement="FR-EXC-027"
          />
          <Metric
            label="Unreconciled rig reports"
            value={units.rigs.value}
            tone={units.rigs.tone}
            link={units.rigs.link}
            data-requirement="FR-EXC-029"
          />
        </div>
      </Card>
    </>
  );
}
