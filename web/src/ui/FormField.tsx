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
  const control = Children.map(children, (child) => {
    if (!isValidElement<{ "aria-describedby"?: string }>(child)) return child;
    // The child's own ids come first: a caller who already wired a
    // description (e.g. a unit hint) keeps it read before this field's.
    const ownIds = child.props["aria-describedby"]?.split(" ") ?? [];
    const describedBy =
      [...ownIds, hintId, errorId].filter((v, i, arr) => v && arr.indexOf(v) === i).join(" ") ||
      undefined;
    const aria: { "aria-describedby"?: string; "aria-invalid"?: boolean } = {};
    if (describedBy) aria["aria-describedby"] = describedBy;
    if (error) aria["aria-invalid"] = true;
    return cloneElement(child, aria);
  });
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
