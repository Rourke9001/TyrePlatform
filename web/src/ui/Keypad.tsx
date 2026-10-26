import type { HTMLAttributes } from "react";

import { cx } from "./cx";
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
  // Names the pad as a group. Optional, so a screen with no group today
  // gains no landmark word.
  ariaLabel?: string;
}

const DIGITS: readonly KeypadDigit[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// TODO(TYRE-447): moves to src/ui/icons/ when lane A's icon modules land.
function BackspaceGlyph() {
  return (
    <svg
      className="tr-key__glyph"
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8.5 5.5H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8.5L3 12z" />
      <path d="M11.5 9.5l5 5M16.5 9.5l-5 5" />
    </svg>
  );
}

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
  return (
    <div
      {...rest}
      className={cx("tr-keypad", className)}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
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
          <BackspaceGlyph />
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
