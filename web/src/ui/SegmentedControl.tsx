import { useRef, type HTMLAttributes, type KeyboardEvent } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import "./SegmentedControl.css";

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: IconGlyph;
}

export interface SegmentedControlProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  // The group's accessible name.
  label: string;
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "md" | "glove";
  block?: boolean;
}

function step(key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}

// A radio group, so it is one tab stop and the arrows move the choice
// (WAI-ARIA radio group). With no option matching the value, the first
// option holds the tab stop, so the group is never skipped by Tab.
export function SegmentedControl({
  label,
  options,
  value,
  onChange,
  size = "md",
  block,
  className,
  ...rest
}: SegmentedControlProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);
  const stop = selected === -1 ? 0 : selected;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Alt+Left is the browser's back, and Ctrl, Cmd and Shift arrows belong
    // to the browser and the screen reader, so a modified arrow passes by.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
      className={cx(
        "tr-seg",
        size === "glove" && "tr-seg--glove",
        block && "tr-seg--block",
        className,
      )}
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
          className="tr-seg__opt"
          onClick={() => onChange(o.value)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          {o.icon ? <Icon icon={o.icon} size={18} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}
