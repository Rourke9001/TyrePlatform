import type { EntryKey } from "./entry";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

// Not the OS keyboard. It covers half a phone screen, takes a beat to appear
// and its keys are sized for typing prose, not for a gloved thumb in the sun
// (NFR-USE-003/004). 108 numeric entries makes that difference minutes.
export function Keypad({
  onKey,
  granularityMm,
  goLabel,
  goTone,
}: {
  onKey: (key: EntryKey) => void;
  granularityMm: number;
  goLabel: string;
  goTone: "default" | "warn";
}) {
  return (
    <div className="cap-keypad">
      {DIGITS.map((d) => (
        <button
          key={d}
          type="button"
          className="cap-key"
          onClick={() => onKey({ type: "digit", digit: d })}
        >
          {d}
        </button>
      ))}
      {/* At 0.5mm granularity the half key takes the delete key's slot: a
          fourth row would push the go key off a small screen, so delete has
          nowhere to live here at that granularity. The driver retypes over a
          mistake instead — a long-press-to-delete affordance is a candidate
          for field trial, not built here without evidence it is needed. */}
      {granularityMm === 0.5 ? (
        <button
          type="button"
          className="cap-key cap-key--alt"
          onClick={() => onKey({ type: "half" })}
        >
          ½
        </button>
      ) : (
        <button
          type="button"
          className="cap-key cap-key--alt"
          aria-label="Delete"
          onClick={() => onKey({ type: "delete" })}
        >
          ⌫
        </button>
      )}
      <button
        type="button"
        className="cap-key"
        onClick={() => onKey({ type: "digit", digit: "0" })}
      >
        0
      </button>
      <button
        type="button"
        className={`cap-key cap-key--go${goTone === "warn" ? " cap-key--warn" : ""}`}
        onClick={() => onKey({ type: "next" })}
      >
        {goLabel}
      </button>
    </div>
  );
}
