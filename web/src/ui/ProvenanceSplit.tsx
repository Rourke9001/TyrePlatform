import type { ProvenanceKey } from "../theme/tokens";
import { formatCount } from "./vocabulary";

export interface ProvenanceSegment {
  key: ProvenanceKey;
  label: string;
  count: number;
}

interface ProvenanceSplitProps {
  segments: ProvenanceSegment[];
  caption: string;
}

// One bar, named segments. The widths are counts over a count, the only
// arithmetic this component does; money never enters it (U27, U31). A
// segment the caller does not pass does not exist: the two casing
// partitions keep their own view's names and never share a shape.
export function ProvenanceSplit({ segments, caption }: ProvenanceSplitProps) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) {
    return <p className="provenance-empty">No tyres to split.</p>;
  }
  const description = `${caption}: ${segments.map((s) => `${s.label} ${formatCount(s.count)}`).join(", ")}`;
  return (
    <figure className="provenance">
      <div className="provenance-bar" role="img" aria-label={description}>
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <span
              key={s.key}
              className={`provenance-segment provenance-${s.key}`}
              data-segment={s.key}
              style={{ width: `${(s.count / total) * 100}%` }}
            />
          ))}
      </div>
      {/* Hidden from a screen reader: the bar's name already carries every
          label and count in words (NFR-USE-009), so each is heard once. */}
      <ul className="provenance-legend" aria-hidden="true">
        {segments.map((s) => (
          <li key={s.key}>
            <span className={`provenance-swatch provenance-${s.key}`} aria-hidden="true" />
            <span className="provenance-label">{s.label}</span>
            <span className="provenance-count">{formatCount(s.count)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
