import { useId, type HTMLAttributes } from "react";

import { cx } from "./cx";
import "./DamageNote.css";

export interface DamageType {
  value: string;
  label: string;
}

export interface DamageNoteProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  // FR-INS-024: the damage types are tenant configuration; the component
  // brings none of its own.
  types: readonly DamageType[];
  type: string | null;
  onTypeChange: (value: string) => void;
  note: string;
  onNoteChange: (value: string) => void;
}

// TODO(TYRE-447): moves to src/ui/icons/ when lane A's icon modules land.
function CheckGlyph() {
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
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

// A driver control by design (TYRE-152, TYRE-448), so every control in it is
// the glove target. It is on the capture entry's forbidden list on this
// branch only because no capture route renders it yet (spec, non-goals).
// TODO(TYRE-447): the chips and the note become lane A's ChoiceChips and TextArea when they land.
export function DamageNote({
  types,
  type,
  onTypeChange,
  note,
  onNoteChange,
  className,
  ...rest
}: DamageNoteProps) {
  const id = useId();
  return (
    <div {...rest} className={cx("tr-damage", className)}>
      <span className="tr-damage__label">Damage</span>
      <div role="radiogroup" aria-label="Damage type" className="tr-damage__chips">
        {types.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={t.value === type}
            className="tr-damage__chip"
            onClick={() => onTypeChange(t.value)}
          >
            {t.value === type ? <CheckGlyph /> : null}
            {t.label}
          </button>
        ))}
      </div>
      <label className="tr-damage__label" htmlFor={`${id}-note`}>
        Note <span className="tr-damage__optional">(optional)</span>
      </label>
      <div className="tr-damage__input">
        <textarea
          id={`${id}-note`}
          rows={2}
          value={note}
          onChange={(e) => onNoteChange(e.currentTarget.value)}
          placeholder="Where it is and how big"
        />
      </div>
    </div>
  );
}
