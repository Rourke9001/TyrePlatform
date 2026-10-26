import type { InputHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./TextInput.css";

export interface TextInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "prefix"
> {
  // Text before the value, such as the tenant's currency symbol.
  prefix?: ReactNode;
  // A unit word after the value, from useUnitLabels() (FR-CFG-021).
  suffix?: ReactNode;
  size?: "md" | "glove";
  // Figures, codes and registrations line their digits up (TYRE-446).
  mono?: boolean;
}

// TextInput, Select, SearchInput, TextArea and Checkbox put className on
// their frame (Checkbox's label) and every other prop on the native
// control: Field gives the control its id, description and aria-invalid
// (Field.tsx), and a form reads the control, not the frame.
export function TextInput({
  prefix,
  suffix,
  size = "md",
  mono,
  className,
  ...rest
}: TextInputProps) {
  const invalid = rest["aria-invalid"] !== undefined && String(rest["aria-invalid"]) !== "false";
  return (
    <div
      className={cx(
        "tr-input",
        size === "glove" && "tr-input--glove",
        mono && "tr-input--mono",
        className,
      )}
      data-invalid={invalid ? "true" : undefined}
    >
      {prefix ? <span className="tr-input__affix">{prefix}</span> : null}
      <input {...rest} />
      {suffix ? <span className="tr-input__affix">{suffix}</span> : null}
    </div>
  );
}
