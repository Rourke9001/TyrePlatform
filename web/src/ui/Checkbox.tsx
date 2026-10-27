import { useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { CheckIcon } from "./icons/Check";
import "./Checkbox.css";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
  // card: a full-width 56px target with a border, for a list a driver
  // ticks (NFR-USE-004).
  variant?: "plain" | "card";
}

// The native input stays in the tree, visually hidden, so the browser's
// checkbox semantics and keyboard handling stay; the box beside it is
// drawn. className and the other props split as TextInput's do.
export function Checkbox({
  label,
  description,
  variant = "plain",
  className,
  ...rest
}: CheckboxProps) {
  const base = useId();
  const labelId = `${base}-label`;
  const descriptionId = `${base}-description`;
  // The whole label stays the target, so its text would name the box with
  // the description in it; the label line names it and the description
  // describes it instead, unless the caller names the box itself.
  const named = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
  const describedBy = [rest["aria-describedby"], description ? descriptionId : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <label className={cx("tr-check", variant === "card" && "tr-check--card", className)}>
      <input
        type="checkbox"
        {...rest}
        aria-labelledby={description && !named ? labelId : rest["aria-labelledby"]}
        aria-describedby={describedBy || undefined}
      />
      <span className="tr-check__box" aria-hidden="true">
        <Icon icon={CheckIcon} size={18} />
      </span>
      <span className="tr-check__text">
        <span className="tr-check__label" id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="tr-check__desc" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
