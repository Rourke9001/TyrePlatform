import type { TextareaHTMLAttributes } from "react";

import { cx } from "./cx";
import "./TextInput.css";
import "./TextArea.css";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: "md" | "glove";
}

// className and the other props split as TextInput's do.
export function TextArea({ size = "md", rows = 3, className, ...rest }: TextAreaProps) {
  const invalid = rest["aria-invalid"] !== undefined && String(rest["aria-invalid"]) !== "false";
  return (
    <div
      className={cx("tr-input", "tr-input--area", size === "glove" && "tr-input--glove", className)}
      data-invalid={invalid ? "true" : undefined}
    >
      <textarea rows={rows} {...rest} />
    </div>
  );
}
