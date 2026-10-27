import type { CSSProperties } from "react";
import { bandRangeLabel } from "../../domain/vocabulary";
import { BandChart, type Band } from "../BandChart";
import { ProvenanceBar } from "../ProvenanceBar";

// Invented counts, none taken from a fixture or a fleet. The labels are
// written from sample bounds the way the dashboard writes them (U40).
function sample(bounds: number[], counts: number[]): Band[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  return bounds.map((lower, i) => ({
    label: bandRangeLabel(lower, bounds[i + 1] ?? null),
    count: counts[i],
    pctOfGroup: (counts[i] * 100) / total,
  }));
}

const five = sample([0, 5, 8, 11, 14], [8, 6, 5, 3, 2]);

// Seven, so the blend above five (U56) can be seen beside the five.
const seven = sample([0, 3, 5, 7, 9, 11, 14], [9, 8, 7, 6, 5, 4, 3]);

// One track no wider than the gallery column, so a wide sample scrolls
// inside itself (the shells' content grids do the same).
const column: CSSProperties = { gridTemplateColumns: "minmax(0, 1fr)" };

export function ChartSamples() {
  return (
    <div className="tr-stack" style={column}>
      <BandChart title="Sample tread depth across running positions" bands={five} />
      <BandChart
        title="Sample tread depth, with a limit"
        bands={five}
        limitBefore={1}
        limitLabel="Sample removal threshold"
      />
      <BandChart title="Sample tread depth, seven bands" bands={seven} />
      <BandChart
        title="Sample tread depth, no tyres"
        bands={five.map((b) => ({ ...b, count: 0 }))}
      />
      <ProvenanceBar
        caption="How the sample value was valued"
        segments={[
          { key: "actual", label: "actual", count: 4 },
          { key: "audit", label: "audit", count: 6 },
          { key: "estimated", label: "estimated", count: 3 },
          { key: "unvalued", label: "not valued", count: 1 },
        ]}
      />
    </div>
  );
}
