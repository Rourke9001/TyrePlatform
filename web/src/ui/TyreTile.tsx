import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./TyreTile.css";

// A tyre's state against the tenant's configured thresholds. The caller
// decides it; this only draws it (rule 5).
export type Condition = "ok" | "near" | "limit" | "unread" | "nospare";

const TONE: Record<Condition, string> = {
  ok: "ok",
  near: "warn",
  limit: "critical",
  unread: "unread",
  nospare: "neutral",
};

// TODO(TYRE-447): these glyphs move to src/ui/icons/ when lane A's icon modules land.
const GLYPH: Record<Condition, ReactNode> = {
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  near: (
    <>
      <path d="M10.3 4.4L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.5h.01" />
    </>
  ),
  limit: (
    <>
      <path d="M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </>
  ),
  unread: <circle cx="12" cy="12" r="8" strokeDasharray="3.2 3" />,
  nospare: <path d="M6 12h12" />,
};

function ConditionGlyph({ condition }: { condition: Condition }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPH[condition]}
    </svg>
  );
}

export interface TyreTileProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "onClick"> {
  // The position's number as the caller shows it: capture's rig-wide number
  // or "S", the vehicle screen's per-unit code (BR-VEH-001, FR-VEH-034).
  numberText: string;
  // Caller-formatted: the governing tread with its unit, or a dash. The
  // tile formats nothing (FR-CFG-021).
  valueText?: string;
  // NFR-USE-009: the state in words, so colour never carries it alone.
  badgeText?: string;
  // Absent is neutral: the vehicle screen's wire carries no condition.
  condition?: Condition;
  // The tile's whole name. Without it the tile's words are its name.
  ariaLabel?: string;
  selected?: boolean;
  // The position open in the sheet, ringed without making the tile a toggle.
  active?: boolean;
  // No tyre is fitted here: drawn, never tapped.
  empty?: boolean;
  onClick?: () => void;
}

export function TyreTile({
  numberText,
  valueText,
  badgeText,
  condition,
  ariaLabel,
  selected,
  active,
  empty,
  onClick,
  className,
  ...rest
}: TyreTileProps) {
  const tone = empty ? "empty" : condition ? TONE[condition] : "neutral";
  // Each attribute written after the spread falls back to the caller's own,
  // so an absent prop never erases a passed-through aria-label or role.
  const name = ariaLabel ?? rest["aria-label"];
  const hidden = name ? true : undefined;
  const content = (
    <>
      <span className="tr-tile__top" aria-hidden={hidden}>
        <span>{numberText}</span>
        {condition && !empty ? <ConditionGlyph condition={condition} /> : null}
      </span>
      {valueText ? (
        <span className="tr-tile__val" aria-hidden={hidden}>
          {valueText}
        </span>
      ) : null}
      {badgeText ? (
        <span className="tr-tile__sub" aria-hidden={hidden}>
          {badgeText}
        </span>
      ) : null}
    </>
  );
  const shared = {
    ...rest,
    className: cx("tr-tile", `tr-tile--${tone}`, className),
    "aria-label": name,
    "data-active": active ? "true" : undefined,
  };
  if (!onClick || empty) {
    return (
      <div {...shared} role={rest.role ?? (name ? "img" : undefined)} data-static="true">
        {content}
      </div>
    );
  }
  return (
    <button
      {...shared}
      type="button"
      aria-pressed={selected ?? rest["aria-pressed"]}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
