import { useId, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import "./Card.css";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  // Names the card: a section with a title is a region a page can find.
  title?: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  // Buttons or links at the top right.
  actions?: ReactNode;
  // none: for a table or list that runs edge to edge.
  padding?: "none" | "md" | "lg";
  level?: 2 | 3;
  as?: "section" | "article";
  children?: ReactNode;
}

export function Card({
  title,
  eyebrow,
  description,
  actions,
  padding = "lg",
  level = 2,
  as: Root = "section",
  className,
  children,
  ...rest
}: CardProps) {
  const titleId = useId();
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <Root
      className={cx("tr-card", `tr-card--pad-${padding}`, className)}
      // A caller's aria-label names the card instead; aria-labelledby would
      // outrank it.
      aria-labelledby={title && rest["aria-label"] === undefined ? titleId : undefined}
      {...rest}
    >
      {title || actions || eyebrow || description ? (
        <div className="tr-card__head">
          <div>
            {eyebrow ? <span className="tr-card__eyebrow">{eyebrow}</span> : null}
            {title ? (
              <Heading id={titleId} className="tr-card__title">
                {title}
              </Heading>
            ) : null}
            {description ? <p className="tr-card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="tr-cluster tr-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Root>
  );
}
