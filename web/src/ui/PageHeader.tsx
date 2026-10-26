import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./cx";
import "./PageHeader.css";

// TODO(TYRE-447): move to src/ui/icons/ when lane A lands
function BackGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  eyebrow?: ReactNode;
  // One sentence: what this page answers.
  description?: ReactNode;
  back?: { label: string; to: string };
  actions?: ReactNode;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  back,
  actions,
  className,
  ...rest
}: PageHeaderProps) {
  return (
    <header className={cx("tr-pagehead", className)} {...rest}>
      <div className="tr-pagehead__text">
        {back ? (
          <Link className="tr-pagehead__back" to={back.to}>
            <BackGlyph />
            {back.label}
          </Link>
        ) : null}
        {eyebrow ? <span className="tr-pagehead__eyebrow">{eyebrow}</span> : null}
        <h1 className="tr-pagehead__title">{title}</h1>
        {description ? <p className="tr-pagehead__desc">{description}</p> : null}
      </div>
      {actions ? <div className="tr-pagehead__actions">{actions}</div> : null}
    </header>
  );
}
