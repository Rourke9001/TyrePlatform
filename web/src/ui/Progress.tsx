import { useId, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

import { formatCount } from "../format/numbers";
import { cx } from "./cx";
import "./Progress.css";

export interface ProgressSegment {
  label: string;
  done: number;
  total: number;
}

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  // Names the bar.
  label: ReactNode;
  // One per unit in the rig; a single unit is one segment.
  segments: ProgressSegment[];
}

export function Progress({ label, segments, className, ...rest }: ProgressProps) {
  const labelId = useId();
  const done = segments.reduce((sum, s) => sum + s.done, 0);
  const total = segments.reduce((sum, s) => sum + s.total, 0);
  const count = `${formatCount(done)} of ${formatCount(total)}`;
  return (
    <div className={cx("tr-progress", className)} {...rest}>
      <div className="tr-progress__top">
        <span id={labelId} className="tr-progress__label">
          {label}
        </span>
        <span className="tr-progress__count">{count}</span>
      </div>
      <div
        className="tr-progress__track"
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={count}
      >
        {segments.map((s) => (
          <span
            key={s.label}
            className="tr-progress__seg"
            style={{ "--tr-seg-total": s.total } as CSSProperties}
          >
            <span
              className="tr-progress__fill"
              style={{ width: `${(s.done * 100) / Math.max(s.total, 1)}%` }}
            />
          </span>
        ))}
      </div>
      {segments.length > 1 ? (
        <div className="tr-progress__legend">
          {segments.map((s) => (
            <span key={s.label}>
              <b>{s.label}</b>{" "}
              {s.done === s.total ? "done" : `${formatCount(s.total - s.done)} left`}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
