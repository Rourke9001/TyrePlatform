import type { ComponentType, SVGProps } from "react";

import { cx } from "./cx";
import "./Icon.css";

// One glyph from src/ui/icons/, which draws only its shapes on a 24px grid.
export type IconGlyph = ComponentType;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  icon: IconGlyph;
  size?: number;
  // Set when the icon carries meaning on its own; omit when a word sits
  // beside it, so a screen reader does not read the meaning twice.
  label?: string;
}

// The glyph comes in as a component, never a name looked up in a map, so a
// route's bundle carries only the glyphs it imports (TYRE-447). Strokes
// follow currentColor, so the icon takes its control's colour in either
// theme (ADR-0020).
export function Icon({ icon: Glyph, size = 20, label, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      {...rest}
      className={cx("tr-icon", className)}
    >
      <Glyph />
    </svg>
  );
}
