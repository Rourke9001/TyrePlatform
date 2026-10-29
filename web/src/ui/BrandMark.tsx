import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./BrandMark.css";

export interface BrandMarkProps extends HTMLAttributes<HTMLSpanElement> {
  // The organisation's display name and served logo, from useBranding().
  // ThemeProvider already derives and applies the brand colour (TYRE-26),
  // so the mark takes its words and image as props and reads no context.
  name: string;
  logoUrl: string | null;
  showName?: boolean;
  // A second line under the name, such as the depot.
  subtitle?: ReactNode;
  // Set on a brand band, so the monogram tile carries an outline.
  onBrand?: boolean;
  size?: "sm" | "md";
}

function monogram(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  // By code point, not UTF-16 unit, so a character outside the basic
  // plane is never cut in half.
  const chars = words.map((w) => Array.from(w));
  if (words.length === 1) return chars[0].slice(0, 2).join("").toUpperCase();
  return (chars[0][0] + chars[1][0]).toUpperCase();
}

// The tile is decoration: the name is read once, from the visible line or
// from hidden text when the line is not shown.
export function BrandMark({
  name,
  logoUrl,
  showName = true,
  subtitle,
  onBrand,
  size = "md",
  className,
  ...rest
}: BrandMarkProps) {
  const hasLogo = Boolean(logoUrl);
  return (
    <span {...rest} className={cx("tr-brandmark", size === "sm" && "tr-brandmark--sm", className)}>
      <span
        className={cx(
          "tr-brandmark__tile",
          hasLogo && "tr-brandmark__tile--logo",
          !hasLogo && onBrand && "tr-brandmark__tile--on-brand",
        )}
        aria-hidden="true"
      >
        {logoUrl ? <img src={logoUrl} alt="" /> : monogram(name)}
      </span>
      {showName ? (
        <span className="tr-brandmark__name">
          {name}
          {subtitle ? <span className="tr-brandmark__sub">{subtitle}</span> : null}
        </span>
      ) : (
        <span className="tr-vh">{name}</span>
      )}
    </span>
  );
}
