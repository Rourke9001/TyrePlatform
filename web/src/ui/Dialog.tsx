import {
  Children,
  useId,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

import { cx } from "./cx";
import { useFocusTrap } from "./focusTrap";
import { Icon } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import "./Dialog.css";

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  // Called on Escape, and on a backdrop click when dismissOnBackdrop is set.
  // The caller owns the open state, so a form can refuse to close while a
  // write is pending.
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  // What happens if they go ahead, when there is no description.
  children?: ReactNode;
  // A secondary "keep it" and the action.
  actions: ReactNode;
  tone?: "default" | "danger";
  inline?: boolean;
  // A click on the scrim outside the panel calls onClose, as Escape does.
  // Off by default: a confirmation is answered by one of its actions.
  dismissOnBackdrop?: boolean;
  // Takes focus back on close; see useFocusTrap for when a caller needs it.
  returnTo?: RefObject<HTMLElement | SVGElement | null>;
}

// role="dialog", not the artifact's alertdialog, so the screens' tests that
// find a dialog by role hold (TYRE-443, spec non-goals).
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  tone = "default",
  inline,
  dismissOnBackdrop = false,
  returnTo,
  className,
  ...rest
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  // A click closes only when the press and the release both landed on the
  // scrim: a drag across the panel's edge, out or in, clicks the scrim,
  // their common ancestor.
  const pressedScrim = useRef(false);
  const releasedScrim = useRef(false);
  const titleId = useId();
  const describedId = useId();
  useFocusTrap(panel, open, onClose, returnTo);
  if (!open) return null;
  // false, null, undefined and "" render nothing, so they draw no element
  // and describe nothing. toArray drops the first three, not "".
  const drawn = (node: ReactNode) => Children.toArray(node).some((child) => child !== "");
  const hasDescription = drawn(description);
  const hasBody = drawn(children);
  const described = hasDescription || hasBody;
  return (
    <div
      className={cx("tr-dialog__scrim", inline && "tr-dialog__scrim--inline")}
      onMouseDown={(e) => {
        pressedScrim.current = e.target === e.currentTarget;
        releasedScrim.current = false;
      }}
      onMouseUp={(e) => {
        releasedScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const closes =
          dismissOnBackdrop &&
          pressedScrim.current &&
          releasedScrim.current &&
          e.target === e.currentTarget;
        pressedScrim.current = false;
        releasedScrim.current = false;
        if (closes) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={described ? describedId : undefined}
        tabIndex={-1}
        className={cx("tr-dialog", className)}
        {...rest}
      >
        {tone === "danger" ? (
          <span className="tr-dialog__icon" aria-hidden="true">
            <Icon icon={AlertIcon} size={24} />
          </span>
        ) : null}
        <h2 className="tr-dialog__title" id={titleId}>
          {title}
        </h2>
        {hasDescription ? (
          <p className="tr-dialog__desc" id={describedId}>
            {description}
          </p>
        ) : null}
        {hasBody ? (
          <div className="tr-dialog__body" id={hasDescription ? undefined : describedId}>
            {children}
          </div>
        ) : null}
        <div className="tr-dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
