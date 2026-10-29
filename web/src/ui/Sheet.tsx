import { useId, useRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";

import { cx } from "./cx";
import { useFocusTrap } from "./focusTrap";
import { Icon } from "./Icon";
import { CloseIcon } from "./icons/Close";
import "./Sheet.css";

interface SheetOwnProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  open: boolean;
  title: ReactNode;
  // The accessible name when it differs from the visible title: a spare's
  // sheet is titled "Spare tyre" and named for its unit.
  ariaLabel?: string;
  eyebrow?: ReactNode;
  description?: ReactNode;
  // bottom on a phone, right for a row's detail on a desk.
  side?: "bottom" | "right";
  // Controls in the head, before Close.
  actions?: ReactNode;
  // A control after Close, last in the head's tab order, where today's
  // spare sheet keeps "No spare" (TYRE-155).
  trailing?: ReactNode;
  footer?: ReactNode;
  titleAs?: "h2" | "h3" | "p";
  closeLabel?: string;
  children?: ReactNode;
}

interface ModalSheetProps extends SheetOwnProps {
  modal?: true;
  onClose: () => void;
  // Positions the overlay in its nearest positioned ancestor, not the
  // viewport.
  inline?: boolean;
  // Takes focus back on close; see useFocusTrap for when a caller needs it.
  returnTo?: RefObject<HTMLElement | SVGElement | null>;
}

// The capture tyre sheet is not modal (ADR-0020, U145): the rig stays
// reachable, so this one traps nothing and the caller's layer places it.
interface DockedSheetProps extends SheetOwnProps {
  modal: false;
  onClose?: () => void;
  inline?: never;
  returnTo?: never;
}

export type SheetProps = ModalSheetProps | DockedSheetProps;

export function Sheet({
  open,
  onClose,
  title,
  ariaLabel,
  eyebrow,
  description,
  side = "bottom",
  actions,
  trailing,
  footer,
  titleAs: Title = "h2",
  closeLabel = "Close",
  modal = true,
  inline,
  returnTo,
  className,
  children,
  ...rest
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panel, open && modal, () => onClose?.(), returnTo);
  if (!open) return null;

  const naming = ariaLabel ? { "aria-label": ariaLabel } : { "aria-labelledby": titleId };
  const classes = cx("tr-sheet", `tr-sheet--${side}`, !modal && "tr-sheet--docked", className);
  const content = (
    <>
      {side === "bottom" ? <span className="tr-sheet__grab" aria-hidden="true" /> : null}
      <div className="tr-sheet__head">
        <div className="tr-sheet__titles">
          {eyebrow ? <span className="tr-sheet__eyebrow">{eyebrow}</span> : null}
          <Title className="tr-sheet__title" id={titleId}>
            {title}
          </Title>
          {description ? <p className="tr-sheet__desc">{description}</p> : null}
        </div>
        {actions}
        {onClose ? (
          <button
            type="button"
            className="tr-sheet__close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <Icon icon={CloseIcon} size={22} className="tr-sheet__glyph" />
          </button>
        ) : null}
        {trailing}
      </div>
      <div className="tr-sheet__body">{children}</div>
      {footer ? <div className="tr-sheet__foot">{footer}</div> : null}
    </>
  );

  if (!modal) {
    return (
      <section className={classes} {...naming} {...rest}>
        {content}
      </section>
    );
  }
  return (
    <div
      className={cx("tr-overlay", `tr-overlay--${side}`, inline && "tr-overlay--inline")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={classes}
        {...naming}
        {...rest}
      >
        {content}
      </div>
    </div>
  );
}
