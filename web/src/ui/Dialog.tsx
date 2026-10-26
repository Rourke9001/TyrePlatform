import { useId, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import { useFocusTrap } from "./focusTrap";
import "./Dialog.css";

// TODO(TYRE-447): move to src/ui/icons/ when lane A lands
function AlertGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.3 4.4L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.5h.01" />
    </svg>
  );
}

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  // Called on Escape. The caller owns the open state, so a form can refuse
  // to close while a write is pending.
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  // What happens if they go ahead, when there is no description.
  children?: ReactNode;
  // A secondary "keep it" and the action.
  actions: ReactNode;
  tone?: "default" | "danger";
  inline?: boolean;
}

// role="dialog", not the artifact's alertdialog: the screens it replaces
// expose a dialog, and their tests and copy stay as they are (TYRE-443).
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  tone = "default",
  inline,
  className,
  ...rest
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const describedId = useId();
  useFocusTrap(panel, open, onClose);
  if (!open) return null;
  const described = description !== undefined || children !== undefined;
  return (
    <div className={cx("tr-dialog__scrim", inline && "tr-dialog__scrim--inline")}>
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
            <AlertGlyph />
          </span>
        ) : null}
        <h2 className="tr-dialog__title" id={titleId}>
          {title}
        </h2>
        {description !== undefined ? (
          <p className="tr-dialog__desc" id={describedId}>
            {description}
          </p>
        ) : null}
        {children !== undefined ? (
          <div className="tr-dialog__body" id={description === undefined ? describedId : undefined}>
            {children}
          </div>
        ) : null}
        <div className="tr-dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
