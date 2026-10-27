import { useId, type HTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { ChevronRightIcon } from "./icons/ChevronRight";
import "./Metric.css";

export interface MetricProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  label: ReactNode;
  // The figure, already formatted: money through formatMoney, counts
  // through formatCount (rule 2, U55).
  value: ReactNode;
  unit?: ReactNode;
  icon?: ReactNode;
  // Colours the figure, only when the figure itself is the problem; the
  // label and detail carry it in words (NFR-USE-009).
  tone?: "default" | "critical" | "warning" | "ok";
  // What the figure counts or is made of. A div, so it may hold a list.
  detail?: ReactNode;
  size?: "md" | "hero";
  // The label nests under the heading the tile sits beneath.
  headingLevel?: 2 | 3;
  // Its own link, in the caller's words, so the tile never becomes one
  // anchor with every figure in its name.
  link?: { to: string; label: string };
  // A chart, a split or the clock it is judged at, under the detail.
  children?: ReactNode;
}

export function Metric({
  label,
  value,
  unit,
  icon,
  tone = "default",
  detail,
  size = "md",
  headingLevel = 3,
  link,
  className,
  children,
  ...rest
}: MetricProps) {
  const labelId = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article
      className={cx(
        "tr-metric",
        tone !== "default" && `tr-metric--${tone}`,
        size === "hero" && "tr-metric--hero",
        className,
      )}
      aria-labelledby={labelId}
      {...rest}
    >
      <Heading id={labelId} className="tr-metric__label">
        {icon ? (
          <span className="tr-metric__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {label}
      </Heading>
      <p className="tr-metric__value">
        <span className="tr-metric__figure">{value}</span>
        {unit ? <span className="tr-metric__unit">{unit}</span> : null}
      </p>
      {detail ? <div className="tr-metric__detail">{detail}</div> : null}
      {children ? <div className="tr-metric__foot">{children}</div> : null}
      {link ? (
        <Link className="tr-metric__link" to={link.to}>
          {link.label}
          <Icon icon={ChevronRightIcon} size={18} />
        </Link>
      ) : null}
    </article>
  );
}
