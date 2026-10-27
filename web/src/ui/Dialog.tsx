import { Children, useId, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import { useFocusTrap } from "./focusTrap";
import { Icon } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import "./Dialog.css";

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
  // false, null and undefined render nothing, so they draw no element and
  // describe nothing.
  const hasDescription = Children.toArray(description).length > 0;
  const hasBody = Children.toArray(children).length > 0;
  const described = hasDescription || hasBody;
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
