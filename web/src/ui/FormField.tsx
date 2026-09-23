import { Children, cloneElement, isValidElement, type ReactNode } from "react";

interface FormFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

// The control is the caller's (an input, a Select); this wires the label,
// the hint and the error to it by id so a screen reader hears all three.
export function FormField({ id, label, hint, error, children }: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = Children.map(children, (child) =>
    isValidElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>(child)
      ? cloneElement(child, {
          "aria-describedby": describedBy,
          "aria-invalid": error ? true : undefined,
        })
      : child,
  );
  return (
    <div className={`field${error ? " field-invalid" : ""}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
