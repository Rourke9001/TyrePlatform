import type { BelowThreshold, ValueAtRisk } from "../api/dashboard";
import { Icon } from "../ui/Icon";
import { CoinsIcon } from "../ui/icons/Coins";
import { Metric } from "../ui/Metric";
import { ProvenanceBar } from "../ui/ProvenanceBar";
import { heroView } from "./dashboard.view";
import { useMoneyText } from "./useMoneyText";

interface ValueAtRiskHeroProps {
  valueAtRisk: ValueAtRisk;
  belowThreshold: BelowThreshold;
  moneyVisible: boolean;
  depot?: string;
}

// FR-DSH-017: the one hero figure on the page (heroView says what it holds).
export function ValueAtRiskHero({
  valueAtRisk,
  belowThreshold,
  moneyVisible,
  depot,
}: ValueAtRiskHeroProps) {
  const hero = heroView({ valueAtRisk, belowThreshold, moneyVisible }, depot);
  const money = useMoneyText();
  return (
    <Metric
      // A region, not Metric's article: the page's one hero figure stays a
      // landmark a reader can jump to (FR-DSH-017).
      role="region"
      size="hero"
      headingLevel={2}
      icon={<Icon icon={CoinsIcon} />}
      label="Value at risk"
      value={money.figure(hero.figure)}
      tone={hero.tone}
      detail={
        <>
          <p>{hero.qualifier}</p>
          <p>{hero.footnote}</p>
        </>
      }
      link={hero.link}
      className="overview-hero"
      data-requirement="FR-DSH-017"
    >
      <ProvenanceBar caption="Running value at risk provenance" segments={hero.segments} />
      <p className="overview-hero__spare">{money.line(hero.spare)}</p>
    </Metric>
  );
}
