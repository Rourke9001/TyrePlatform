import { useRef, type HTMLAttributes, type KeyboardEvent } from "react";

import { formatCount } from "../format/numbers";
import { cx } from "./cx";
import "./Tabs.css";

export interface TabItem {
  value: string;
  label: string;
  // The tab's own id, and the id of the TabPanel it shows.
  id: string;
  panelId: string;
  count?: number;
  // Shows a count above zero as a critical pill; the label carries the word.
  critical?: boolean;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  // The accessible name of the tab list.
  label: string;
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
}

const MOVES: Partial<Record<string, (at: number, last: number) => number>> = {
  ArrowRight: (at, last) => (at === last ? 0 : at + 1),
  ArrowLeft: (at, last) => (at === 0 ? last : at - 1),
  Home: () => 0,
  End: (_at, last) => last,
};

// WAI-ARIA's tabs pattern with automatic activation: one tab stop, the
// arrows, Home and End move and select at once, and Tab goes on to the panel.
export function Tabs({ label, items, value, onChange, className, ...rest }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVES[event.key];
    if (move === undefined || items.length === 0) return;
    event.preventDefault();
    const at = Math.max(
      items.findIndex((t) => t.value === value),
      0,
    );
    const next = items[move(at, items.length - 1)];
    onChange(next.value);
    list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={cx("tr-tabs", className)}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {items.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={t.id}
            aria-controls={t.panelId}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-tab={t.value}
            className="tr-tab"
            onClick={() => onChange(t.value)}
          >
            {t.label}
            {t.count !== undefined ? (
              <>
                {" "}
                <span
                  className={cx(
                    "tr-tab__count",
                    t.critical && t.count > 0 && "tr-tab__count--critical",
                  )}
                >
                  {formatCount(t.count)}
                </span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
