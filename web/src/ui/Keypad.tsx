import type { HTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { BackspaceIcon } from "./icons/Backspace";
import "./Keypad.css";

export type KeypadDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type KeypadKey = KeypadDigit | "delete" | "half" | "go";

export interface KeypadProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  onKey: (key: KeypadKey) => void;
  // The go key's whole accessible name, so the caller's words ("Next ›",
  // "Seen it ›") are what a screen reader and a test both find.
  goLabel: string;
  // U145: no decimal key. A tenant at 0.5 mm gets the half key in the slot
  // left of 0; every other tenant gets Delete there.
  altKey?: "delete" | "half";
  goTone?: "primary" | "warn";
  goDisabled?: boolean;
  // Names the pad, and only then makes it a group, so a screen whose keypad
  // has no role or name today gains neither (copy unchanged, TYRE-443).
  ariaLabel?: string;
}

const DIGITS: readonly KeypadDigit[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// Not the OS keyboard: NFR-USE-003/004 want keys sized for a gloved thumb,
// and four rows keep go on a 780px screen (TYRE-220).
export function Keypad({
  onKey,
  goLabel,
  altKey = "delete",
  goTone = "primary",
  goDisabled,
  ariaLabel,
  className,
  ...rest
}: KeypadProps) {
  // Falls back to the caller's own attributes, so an absent ariaLabel never
  // erases a passed-through aria-label or role.
  const name = ariaLabel ?? rest["aria-label"];
  return (
    <div
      {...rest}
      className={cx("tr-keypad", className)}
      role={rest.role ?? (name ? "group" : undefined)}
      aria-label={name}
    >
      {DIGITS.map((d) => (
        <button key={d} type="button" className="tr-key" onClick={() => onKey(d)}>
          {d}
        </button>
      ))}
      {altKey === "half" ? (
        <button type="button" className="tr-key tr-key--fn" onClick={() => onKey("half")}>
          ½
        </button>
      ) : (
        <button
          type="button"
          className="tr-key tr-key--fn"
          aria-label="Delete"
          onClick={() => onKey("delete")}
        >
          <Icon icon={BackspaceIcon} size={28} className="tr-key__glyph" />
        </button>
      )}
      <button type="button" className="tr-key" onClick={() => onKey("0")}>
        0
      </button>
      <button
        type="button"
        className={cx("tr-key", "tr-key--go", goTone === "warn" && "tr-key--warn")}
        disabled={goDisabled}
        onClick={() => onKey("go")}
      >
        {goLabel}
      </button>
    </div>
  );
}
