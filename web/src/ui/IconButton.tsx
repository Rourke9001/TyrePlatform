import type { ButtonHTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import "./IconButton.css";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  // The accessible name, required because there is no visible word.
  label: string;
  icon: IconGlyph;
  // on-brand sits on the brand band of an app bar (U53).
  variant?: "ghost" | "secondary" | "on-brand";
  size?: "md" | "glove";
}

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      title={label}
      {...rest}
      // After the spread: with no visible word, the name is always label.
      aria-label={label}
      type={type}
      className={cx(
        "tr-iconbtn",
        variant !== "ghost" && `tr-iconbtn--${variant}`,
        size === "glove" && "tr-iconbtn--glove",
        className,
      )}
    >
      <Icon icon={icon} size={size === "glove" ? 24 : 20} />
    </button>
  );
}
