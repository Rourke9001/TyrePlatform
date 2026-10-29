import type { HTMLAttributes } from "react";

import { groupThousands } from "../format/groupThousands";
import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import { CriticalIcon } from "./icons/Critical";
import { InfoIcon } from "./icons/Info";
import "./Badge.css";
import "./SeverityBadge.css";

export type Severity = "critical" | "warning" | "info";

const SEVERITY: Record<Severity, { icon: IconGlyph; tone: string }> = {
  critical: { icon: CriticalIcon, tone: "critical" },
  warning: { icon: AlertIcon, tone: "warn" },
  info: { icon: InfoIcon, tone: "info" },
};

export interface SeverityBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  severity: Severity;
  size?: "sm" | "md";
  // Appended to the word, as in "Critical 4".
  count?: number;
  // The severity's words are the caller's, from severityLabel in
  // src/domain/vocabulary.ts and nowhere else (TYRE-270).
  label: string;
}

// A glyph per severity as well as its colour, so the badge reads in
// greyscale and to a colour-blind reader (NFR-USE-009).
export function SeverityBadge({
  severity,
  size = "sm",
  count,
  label,
  className,
  ...rest
}: SeverityBadgeProps) {
  const s = SEVERITY[severity];
  return (
    <span
      {...rest}
      className={cx("tr-badge", `tr-badge--${s.tone}`, size === "md" && "tr-badge--md", className)}
    >
      <Icon icon={s.icon} size={size === "md" ? 18 : 16} />
      {label}
      {count !== undefined ? (
        <span className="tr-mono"> {groupThousands(String(count))}</span>
      ) : null}
    </span>
  );
}
