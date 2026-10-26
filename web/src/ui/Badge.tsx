import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import "./Badge.css";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  // One to three plain words, such as a tyre's state or a role. Never a
  // condition: StatusBadge carries those.
  children: ReactNode;
  icon?: IconGlyph;
}

export function Badge({ children, icon, className, ...rest }: BadgeProps) {
  return (
    <span {...rest} className={cx("tr-badge", "tr-badge--neutral", className)}>
      {icon ? <Icon icon={icon} size={16} /> : null}
      {children}
    </span>
  );
}
