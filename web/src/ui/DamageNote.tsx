import { useId, type HTMLAttributes } from "react";

import { ChoiceChips } from "./ChoiceChips";
import { cx } from "./cx";
import { TextArea } from "./TextArea";
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

// A driver control by design (TYRE-152, TYRE-448), so every control in it is
// the glove target. It is on the capture entry's forbidden list on this
// branch only because no capture route renders it yet (spec, non-goals).
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
      <ChoiceChips
        label="Damage type"
        size="glove"
        options={types}
        value={type}
        onChange={onTypeChange}
      />
      <label className="tr-damage__label" htmlFor={`${id}-note`}>
        Note <span className="tr-damage__optional">(optional)</span>
      </label>
      <TextArea
        id={`${id}-note`}
        size="glove"
        rows={2}
        value={note}
        onChange={(e) => onNoteChange(e.currentTarget.value)}
        placeholder="Where it is and how big"
      />
    </div>
  );
}
