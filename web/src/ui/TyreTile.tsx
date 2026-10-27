import type { HTMLAttributes } from "react";

import type { Condition } from "./condition";
import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import { CheckIcon } from "./icons/Check";
import { CriticalIcon } from "./icons/Critical";
import { MinusIcon } from "./icons/Minus";
import { UnreadIcon } from "./icons/Unread";
import "./TyreTile.css";

const TONE: Record<Condition, string> = {
  ok: "ok",
  near: "warn",
  limit: "critical",
  unread: "unread",
  nospare: "neutral",
};

const GLYPH: Record<Condition, IconGlyph> = {
  ok: CheckIcon,
  near: AlertIcon,
  limit: CriticalIcon,
  unread: UnreadIcon,
  nospare: MinusIcon,
};

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
        {condition && !empty ? <Icon icon={GLYPH[condition]} size={16} /> : null}
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
