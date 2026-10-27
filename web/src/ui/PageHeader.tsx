import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { ChevronLeftIcon } from "./icons/ChevronLeft";
import "./PageHeader.css";

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  // The h1's content. PageHeader draws the h1, so a screen whose section is
  // named by its heading puts the id on a span inside it.
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
    // A div, not a header element: inside a shell a header reads as a
    // second banner beside the shell's own.
    <div className={cx("tr-pagehead", className)} {...rest}>
      <div className="tr-pagehead__text">
        {back ? (
          <Link className="tr-pagehead__back" to={back.to}>
            <Icon icon={ChevronLeftIcon} size={18} />
            {back.label}
          </Link>
        ) : null}
        {eyebrow ? <span className="tr-pagehead__eyebrow">{eyebrow}</span> : null}
        <h1 className="tr-pagehead__title">{title}</h1>
        {description ? <p className="tr-pagehead__desc">{description}</p> : null}
      </div>
      {actions ? <div className="tr-pagehead__actions">{actions}</div> : null}
    </div>
  );
}
