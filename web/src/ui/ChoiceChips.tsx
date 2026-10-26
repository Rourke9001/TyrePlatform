import { useRef, type HTMLAttributes, type KeyboardEvent } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { Check } from "./icons/Check";
import "./ChoiceChips.css";

export interface ChoiceChipsProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  // The group's accessible name.
  label: string;
  options: readonly { value: string; label: string }[];
  // Null until the driver chooses.
  value: string | null;
  onChange: (value: string) => void;
  size?: "md" | "glove";
}

function step(key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}

// One choice from more options than a segmented control fits on a line.
// A radio group, so it is one tab stop and the arrows move the choice
// (WAI-ARIA radio group); before a choice the first chip holds the stop.
export function ChoiceChips({
  label,
  options,
  value,
  onChange,
  size = "md",
  className,
  ...rest
}: ChoiceChipsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);
  const stop = selected === -1 ? 0 : selected;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const d = step(event.key);
    if (d === 0) return;
    event.preventDefault();
    const next = (index + d + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      {...rest}
      className={cx("tr-chips", size === "glove" && "tr-chips--glove", className)}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === stop ? 0 : -1}
          className="tr-chip"
          onClick={() => onChange(o.value)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          {o.value === value ? <Icon icon={Check} size={16} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}
