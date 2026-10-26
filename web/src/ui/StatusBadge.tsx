import type { HTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import { CheckIcon } from "./icons/Check";
import { CriticalIcon } from "./icons/Critical";
import { MinusIcon } from "./icons/Minus";
import { UnreadIcon } from "./icons/Unread";
import type { Condition } from "./condition";
import "./Badge.css";
import "./StatusBadge.css";

const LOOK: Record<Condition, { icon: IconGlyph; tone: string }> = {
  ok: { icon: CheckIcon, tone: "ok" },
  near: { icon: AlertIcon, tone: "warn" },
  limit: { icon: CriticalIcon, tone: "critical" },
  unread: { icon: UnreadIcon, tone: "unread" },
  nospare: { icon: MinusIcon, tone: "neutral" },
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
