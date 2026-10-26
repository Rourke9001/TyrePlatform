// Gallery.tsx reads `section` through its glob, so a sample that needs a
// hook is declared beside it; this dev-only page reloads on an edit rather
// than hot-swapping (TYRE-447).
/* eslint-disable react-refresh/only-export-components */
import { bandRangeLabel } from "../../domain/vocabulary";
import { BandChart, type Band } from "../BandChart";
import { ProvenanceBar } from "../ProvenanceBar";
import type { GallerySection } from "./types";

// Example values only; none is a fleet figure. The labels are written from
// sample bounds the way the dashboard writes them (U40).
function sample(bounds: number[], counts: number[]): Band[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  return bounds.map((lower, i) => ({
    label: bandRangeLabel(lower, bounds[i + 1] ?? null),
    count: counts[i],
    pctOfGroup: (counts[i] * 100) / total,
  }));
}

const five = sample([0, 5, 8, 11, 14], [10, 4, 6, 5, 2]);

// Seven, so the blend above five (U56) can be seen beside the five.
const seven = sample([0, 3, 5, 7, 9, 11, 14], [9, 8, 7, 6, 5, 4, 3]);

function ChartSamples() {
  return (
    <div className="tr-stack">
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
          { key: "actual", label: "actual", count: 3 },
          { key: "audit", label: "audit", count: 9 },
          { key: "estimated", label: "estimated", count: 5 },
          { key: "unvalued", label: "not valued", count: 2 },
        ]}
      />
    </div>
  );
}

export const section: GallerySection = {
  id: "charts",
  title: "Charts: tread bands and provenance",
  render: () => <ChartSamples />,
};
