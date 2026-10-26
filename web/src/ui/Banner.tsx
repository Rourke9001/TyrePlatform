import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { Alert } from "./icons/Alert";
import { Check } from "./icons/Check";
import { Critical } from "./icons/Critical";
import { Info } from "./icons/Info";
import "./Banner.css";

type Tone = "info" | "warning" | "critical" | "success";

const ICON: Record<Tone, IconGlyph> = {
  info: Info,
  warning: Alert,
  critical: Critical,
  success: Check,
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  // One button or link, on the right.
  action?: ReactNode;
}

// Critical and warning interrupt a screen reader; info and success wait
// their turn.
export function Banner({
  tone = "info",
  title,
  children,
  action,
  className,
  ...rest
}: BannerProps) {
  return (
    <div
      role={tone === "critical" || tone === "warning" ? "alert" : "status"}
      {...rest}
      className={cx("tr-banner", `tr-banner--${tone}`, className)}
    >
      <span className="tr-banner__icon" aria-hidden="true">
        <Icon icon={ICON[tone]} size={18} />
      </span>
      <div>
        <div className="tr-banner__title">{title}</div>
        {children ? <div className="tr-banner__body">{children}</div> : null}
      </div>
      {action ? <div className="tr-banner__action">{action}</div> : <span />}
    </div>
  );
}
