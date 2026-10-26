import type { HTMLAttributes } from "react";

import { cx } from "./cx";
import "./Skeleton.css";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  lines?: number;
  // The last line's width, so the block reads as a paragraph.
  lastWidth?: string;
  // Each line's height in px.
  height?: number;
  // What a screen reader hears while the lines stand in.
  label?: string;
}

// The lines are decoration; a status with hidden words says what is
// loading, since a name on a plain div is not announced.
export function Skeleton({
  lines = 3,
  lastWidth = "60%",
  height = 14,
  label = "Loading",
  className,
  ...rest
}: SkeletonProps) {
  return (
    <div role="status" aria-busy="true" {...rest} className={cx("tr-skel-lines", className)}>
      <span className="tr-vh">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="tr-skel"
          aria-hidden="true"
          style={{ height, width: i === lines - 1 ? lastWidth : "100%" }}
        />
      ))}
    </div>
  );
}
