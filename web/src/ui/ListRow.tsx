import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./cx";
import "./ListRow.css";

// TODO(TYRE-447): move to src/ui/icons/ when lane A lands
function ChevronGlyph() {
  return (
    <svg
      className="tr-row__chev"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, "title" | "onClick"> {
  title?: ReactNode;
  meta?: ReactNode;
  // Drawn in the tile on the left.
  icon?: ReactNode;
  // Any node on the left, without the tile.
  leading?: ReactNode;
  // A badge or figure on the right.
  trailing?: ReactNode;
  to?: string;
  onClick?: () => void;
  // The row's whole text in place of title and meta, so a link keeps a
  // name a page and its tests already read as one string.
  children?: ReactNode;
}

export function ListRow({
  title,
  meta,
  icon,
  leading,
  trailing,
  to,
  onClick,
  className,
  children,
  ...rest
}: ListRowProps) {
  const target = to !== undefined || onClick !== undefined;
  const body = (
    <>
      {icon ? (
        <span className="tr-row__lead" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {leading}
      {children !== undefined ? (
        <span className="tr-row__text">{children}</span>
      ) : (
        <span className="tr-row__body">
          <span className="tr-row__title">{title}</span>
          {meta ? <span className="tr-row__meta">{meta}</span> : null}
        </span>
      )}
      {trailing || target ? (
        <span className="tr-row__trail">
          {trailing}
          {target ? <ChevronGlyph /> : null}
        </span>
      ) : null}
    </>
  );
  const classes = cx("tr-row", className);
  if (to !== undefined) {
    return (
      <Link className={classes} to={to} {...rest}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} {...rest}>
        {body}
      </button>
    );
  }
  return (
    <div className={classes} {...rest}>
      {body}
    </div>
  );
}
