import type { SelectHTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { ChevronDownIcon } from "./icons/ChevronDown";
import "./TextInput.css";
import "./Select.css";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  options: readonly SelectOption[];
  // A first option that names the choice and cannot be chosen back.
  placeholder?: string;
  size?: "md" | "glove";
}

// Native, not Radix: capture carries no Radix (ADR-0015, TYRE-443), and a
// phone's own picker suits a glove. className and the other props split as
// TextInput's do.
export function Select({ options, placeholder, size = "md", className, ...rest }: SelectProps) {
  const invalid = rest["aria-invalid"] !== undefined && String(rest["aria-invalid"]) !== "false";
  return (
    <div
      className={cx("tr-input", size === "glove" && "tr-input--glove", className)}
      data-invalid={invalid ? "true" : undefined}
    >
      <select {...rest}>
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon icon={ChevronDownIcon} size={18} className="tr-input__chev" />
    </div>
  );
}
