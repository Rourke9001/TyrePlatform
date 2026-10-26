import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { CheckIcon } from "./icons/Check";
import "./EmptyState.css";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: IconGlyph;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  // The title nests under the heading the state sits beneath: 3 below a
  // card's h2, 2 directly under a page's h1.
  headingLevel?: 2 | 3 | 4;
}

// An empty result is an answer, never an error: it says what is absent
// and, where one exists, what to do.
export function EmptyState({
  icon = CheckIcon,
  title,
  children,
  action,
  headingLevel = 3,
  className,
  ...rest
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div {...rest} className={cx("tr-empty", className)}>
      <span className="tr-empty__icon" aria-hidden="true">
        <Icon icon={icon} size={28} />
      </span>
      <Heading className="tr-empty__title">{title}</Heading>
      {children ? <p className="tr-empty__body">{children}</p> : null}
      {action ? <div className="tr-empty__action">{action}</div> : null}
    </div>
  );
}
