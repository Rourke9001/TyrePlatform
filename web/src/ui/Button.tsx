import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  // Below the 44px floor on purpose: a control inside a table row on a desk
  // surface, never the gloved one NFR-USE-004 is about (controls.css).
  compact?: boolean;
}

// type="button" by default: a button inside a form submits it unless told
// otherwise, and a Refresh beside a filter form must never do that.
export function Button({
  variant = "primary",
  compact = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, compact ? "btn-compact" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
