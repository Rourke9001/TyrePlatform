import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import type { Condition } from "./condition";
import "./TreadReadings.css";

// The pressure cell sits in the treads' row, so the whole position is on
// screen at once (IR-UI-013). Every word in it is the caller's.
export interface TreadPressure {
  value: string;
  caption: string;
  unitText?: string;
  // Names the cell when it is a button (onSelect given), defaulting to the
  // caption. A static pressure cell has no accessible name of its own.
  ariaLabel?: string;
  active?: boolean;
  onSelect?: () => void;
}

export interface TreadReadingsProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onSelect"
> {
  // CR-011: every width-wise reading, caller-formatted, in the order the
  // driver enters them. An empty string is a reading not yet taken.
  readings: readonly string[];
  // The caller names the governing reading; this never computes a MIN()
  // (rule 4: the database owns that rule).
  governingIndex: number | null;
  activeIndex?: number;
  // Makes each cell a button named by cellLabel. Without it the cells are
  // divs with no accessible name, read as their text.
  onSelect?: (index: number) => void;
  cellLabel?: (index: number, count: number) => string;
  // FR-CFG-021: the unit under each tread value, from the caller.
  unitText?: string;
  pressure?: TreadPressure;
  // FR-INS-029a and U145: a driver's cells are numbered. Named cells
  // (outer, centre, inner from the side, CHG-010) are for manager screens,
  // and only where orientation_known is true. A pre-convention capture
  // stays numbered.
  naming?: "numbered" | "named";
  side?: "left" | "right";
  // Colours the governing mark; the caller judges it against the tenant's
  // thresholds (rule 5).
  condition?: Condition;
  // Words on the governing mark. Without them the mark is an aria-hidden
  // glyph, so a manager screen passes words here. On a button cell the
  // whole mark is aria-hidden, so cellLabel carries any spoken word.
  governingText?: string;
  size?: "md" | "lg";
}

const defaultCellLabel = (i: number, n: number) => `Tread reading ${i + 1} of ${n}`;

const PILL_TONE: Partial<Record<Condition, string>> = {
  ok: "ok",
  near: "warn",
  limit: "critical",
};

function cellNames(count: number, naming: "numbered" | "named", side?: "left" | "right") {
  if (naming === "named" && side && count === 3) {
    return side === "left" ? ["Outer", "Centre", "Inner"] : ["Inner", "Centre", "Outer"];
  }
  return Array.from({ length: count }, (_, i) => String(i + 1));
}

// TODO(TYRE-447): moves to src/ui/icons/ when lane A's icon modules land.
function LowGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}

interface CellProps {
  name: string;
  value: string;
  unitText?: string;
  label?: string;
  active: boolean;
  governing: boolean;
  pill?: ReactNode;
  onClick?: () => void;
}

function Cell({ name, value, unitText, label, active, governing, pill, onClick }: CellProps) {
  const hidden = label ? true : undefined;
  const body = (
    <>
      {pill}
      <span className="tr-tread__name" aria-hidden={hidden}>
        {name}
      </span>
      <span className="tr-tread__val" aria-hidden={hidden}>
        {value === "" ? "–" : value}
      </span>
      {unitText ? (
        <span className="tr-tread__unit" aria-hidden={hidden}>
          {unitText}
        </span>
      ) : null}
    </>
  );
  const shared = {
    className: "tr-tread__cell",
    "data-empty": value === "" ? "true" : undefined,
    "data-governing": governing ? "true" : undefined,
    "aria-current": active ? ("true" as const) : undefined,
  };
  if (!onClick) return <div {...shared}>{body}</div>;
  return (
    <button {...shared} type="button" aria-label={label} onClick={onClick}>
      {body}
    </button>
  );
}

export function TreadReadings({
  readings,
  governingIndex,
  activeIndex,
  onSelect,
  cellLabel = defaultCellLabel,
  unitText,
  pressure,
  naming = "numbered",
  side,
  condition,
  governingText,
  size = "md",
  className,
  ...rest
}: TreadReadingsProps) {
  const n = readings.length;
  const cells = n + (pressure ? 1 : 0);
  const names = cellNames(n, naming, side);
  const tone = condition ? PILL_TONE[condition] : undefined;
  const pill = (
    <span
      className={cx("tr-tread__low", tone && `tr-tread__low--${tone}`)}
      aria-hidden={onSelect ? true : undefined}
    >
      {governingText ?? <LowGlyph />}
    </span>
  );
  return (
    <div
      {...rest}
      className={cx(
        "tr-tread",
        size === "lg" && cells <= 4 && "tr-tread--lg",
        cells > 4 && "tr-tread--dense",
        className,
      )}
    >
      {naming === "named" && side ? (
        <div className="tr-tread__axis" aria-hidden="true">
          <span>{side === "left" ? "Outside" : "Vehicle centre"}</span>
          <span>{side === "left" ? "Vehicle centre" : "Outside"}</span>
        </div>
      ) : null}
      <div className="tr-tread__cells" style={{ "--tr-cells": cells } as CSSProperties}>
        {readings.map((value, i) => (
          <Cell
            key={i}
            name={names[i]}
            value={value}
            unitText={unitText}
            label={onSelect ? cellLabel(i, n) : undefined}
            active={activeIndex === i}
            governing={governingIndex === i}
            pill={governingIndex === i ? pill : undefined}
            onClick={onSelect ? () => onSelect(i) : undefined}
          />
        ))}
        {pressure ? (
          <Cell
            name={pressure.caption}
            value={pressure.value}
            unitText={pressure.unitText}
            label={pressure.onSelect ? (pressure.ariaLabel ?? pressure.caption) : undefined}
            active={pressure.active ?? false}
            governing={false}
            onClick={pressure.onSelect}
          />
        ) : null}
      </div>
    </div>
  );
}
