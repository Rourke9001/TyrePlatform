import type { HTMLAttributes, ReactNode } from "react";

import { formatCount } from "../format/numbers";
import { cx } from "./cx";
import "./ProvenanceBar.css";

// The two disjoint casing partitions' names (ADR-0010, spec U27); a split
// never receives a computed fifth.
export type ProvenanceKey = "actual" | "audit" | "estimated" | "unvalued";

export interface ProvenanceSegment {
  key: ProvenanceKey;
  label: string;
  count: number;
}

export interface ProvenanceBarProps extends HTMLAttributes<HTMLElement> {
  segments: ProvenanceSegment[];
  // Leads the bar's accessible name: what was valued.
  caption: string;
  empty?: ReactNode;
}

// How a figure was valued (NFR-PRO-002): certainty is darker. The widths
// are counts over a count, the only arithmetic here; money never enters it
// (U27, U31).
export function ProvenanceBar({
  segments,
  caption,
  empty = "No tyres to split.",
  className,
  ...rest
}: ProvenanceBarProps) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return <p className="tr-prov__empty">{empty}</p>;
  const name = `${caption}: ${segments.map((s) => `${s.label} ${formatCount(s.count)}`).join(", ")}`;
  return (
    <figure className={cx("tr-prov", className)} {...rest}>
      <div className="tr-prov__bar" role="img" aria-label={name}>
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <span
              key={s.key}
              className={`tr-prov__seg tr-prov__seg--${s.key}`}
              data-segment={s.key}
              style={{ flexGrow: s.count }}
            />
          ))}
      </div>
      {/* Hidden from a screen reader: the bar's name already carries every
          label and count in words (NFR-USE-009), so each is heard once. */}
      <ul className="tr-prov__legend" aria-hidden="true">
        {segments.map((s) => (
          <li key={s.key}>
            <span className={`tr-prov__key tr-prov__seg--${s.key}`} />
            {s.label} <b>{formatCount(s.count)}</b>
          </li>
        ))}
      </ul>
    </figure>
  );
}
