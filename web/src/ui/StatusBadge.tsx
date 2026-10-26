import type { HTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { Alert } from "./icons/Alert";
import { Check } from "./icons/Check";
import { Critical } from "./icons/Critical";
import { Minus } from "./icons/Minus";
import { Unread } from "./icons/Unread";
import "./Badge.css";
import "./StatusBadge.css";

// A tyre's condition against the tenant's configured thresholds. The
// thresholds are tenant data (rule 5); this only names the outcome.
export type Condition = "ok" | "near" | "limit" | "unread" | "nospare";

const LOOK: Record<Condition, { icon: IconGlyph; tone: string }> = {
  ok: { icon: Check, tone: "ok" },
  near: { icon: Alert, tone: "warn" },
  limit: { icon: Critical, tone: "critical" },
  unread: { icon: Unread, tone: "unread" },
  nospare: { icon: Minus, tone: "neutral" },
};

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status: Condition;
  // The caller's word, so each screen keeps its own copy.
  label: string;
  size?: "sm" | "md";
}

// Names a condition it is given and never computes one (rule 5).
export function StatusBadge({ status, label, size = "sm", className, ...rest }: StatusBadgeProps) {
  const look = LOOK[status];
  return (
    <span
      {...rest}
      className={cx(
        "tr-badge",
        `tr-badge--${look.tone}`,
        size === "md" && "tr-badge--md",
        className,
      )}
    >
      <Icon icon={look.icon} size={size === "md" ? 18 : 16} />
      {label}
    </span>
  );
}
