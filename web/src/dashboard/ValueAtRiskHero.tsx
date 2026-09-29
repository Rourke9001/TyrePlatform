import { Link } from "react-router";

import type { BelowThreshold, ValueAtRisk } from "../api/dashboard";
import { moneyOrEmpty, moneyText } from "../api/money";
import { ProvenanceSplit } from "../ui/ProvenanceSplit";
import { absenceLabel, formatCount, judgedAtLabel, plural } from "../ui/vocabulary";
import { withDepot } from "./dashboardParams";

interface ValueAtRiskHeroProps {
  valueAtRisk: ValueAtRisk;
  belowThreshold: BelowThreshold;
  moneyVisible: boolean;
  depot?: string;
}

// FR-DSH-017: the one hero figure on the page, with its provenance and the
// spares disclosed apart (BR-RPT-001).
export function ValueAtRiskHero({
  valueAtRisk,
  belowThreshold,
  moneyVisible,
  depot,
}: ValueAtRiskHeroProps) {
  const { running, spare } = valueAtRisk;
  return (
    <section className="hero" aria-labelledby="hero-title" data-requirement="FR-DSH-017">
      <h2 id="hero-title" className="hero-label">
        Value at risk
      </h2>
      <p className="hero-figure">
        {moneyOrEmpty(
          running.casingValueAtRisk,
          moneyVisible,
          running.tyreCount,
          absenceLabel("noneAtRisk"),
        )}
      </p>
      {/* U18: the register's today count, not the exception count, which is
          judged at each unit's latest inspection. */}
      <p className="hero-qualifier">
        from {plural(belowThreshold.running, "running tyre", "running tyres")} at or below the
        removal threshold {judgedAtLabel(belowThreshold.judgedAt)}
      </p>
      <p className="hero-footnote">
        {formatCount(running.actualCount)} at actual cost,{" "}
        {formatCount(running.estimatedOrAuditCount)} estimated or audit, of which{" "}
        {formatCount(running.auditCount)} audit; {formatCount(running.unvaluedCount)} unvalued
      </p>
      <ProvenanceSplit
        caption="Running value at risk provenance"
        segments={[
          { key: "actual", label: "Actual", count: running.actualCount },
          { key: "estimated", label: "Estimated or audit", count: running.estimatedOrAuditCount },
          { key: "unvalued", label: "Unvalued", count: running.unvaluedCount },
        ]}
      />
      {/* U36, U44: an empty spare class is its absence, the whole line;
          Hidden still wins over it. */}
      <p className="hero-spare">
        {moneyVisible && spare.tyreCount === 0 ? (
          absenceLabel("noSparesAtRisk")
        ) : (
          <>
            Spares: {moneyText(spare.casingValueAtRisk, moneyVisible)} from{" "}
            {plural(spare.tyreCount, "tyre", "tyres")}
            {spare.unvaluedCount > 0 && `, ${formatCount(spare.unvaluedCount)} unvalued`}
          </>
        )}
      </p>
      {/* D7: /at-risk is gated on ViewValuation, so a reader without it
          is not offered a link to a refusal. */}
      {moneyVisible && (
        <Link className="hero-link" to={withDepot("/at-risk", depot)}>
          See the at-risk list
        </Link>
      )}
    </section>
  );
}
