import {
  cloneElement,
  useId,
  type AriaAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { Critical } from "./icons/Critical";
import "./Field.css";

interface ControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
}

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  // One control. Field gives it an id unless it has one, and adds the hint
  // and the error to whatever description it already carries.
  children: ReactElement<ControlProps>;
}

export function Field({ label, hint, error, optional, children, className, ...rest }: FieldProps) {
  const base = useId();
  const own = children.props;
  const id = own.id ?? `field${base}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [own["aria-describedby"], hintId, errorId].filter(Boolean).join(" ");
  const control = cloneElement(children, {
    id,
    "aria-describedby": describedBy || undefined,
    ...(error ? { "aria-invalid": true } : {}),
  });
  return (
    <div {...rest} className={cx("tr-field", className)}>
      <label className="tr-field__label" htmlFor={id}>
        {label}
        {optional ? <span className="tr-field__optional"> (optional)</span> : null}
      </label>
      {hint ? (
        <div className="tr-field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {control}
      {error ? (
        <div className="tr-field__error" id={errorId}>
          <Icon icon={Critical} size={18} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
