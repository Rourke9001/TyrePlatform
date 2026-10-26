import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./Timeline.css";

type Tone = "ok" | "warn" | "critical" | "neutral";

// TODO(TYRE-447): move to src/ui/icons/ when lane A lands
const GLYPHS: Record<Tone, ReactNode> = {
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  warn: (
    <>
      <path d="M10.3 4.4L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.5h.01" />
    </>
  ),
  critical: (
    <>
      <path d="M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </>
  ),
  neutral: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};

export interface TimelineItem {
  id: string;
  // Already formatted through src/time/tenantTime.ts (rule 6).
  when: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  // Replaces the tone's glyph in the dot.
  icon?: ReactNode;
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  items: TimelineItem[];
}

// Each event's words carry its tone; the dot repeats it in shape and
// colour, so it is hidden (NFR-USE-009).
export function Timeline({ items, className, ...rest }: TimelineProps) {
  return (
    <ol className={cx("tr-timeline", className)} {...rest}>
      {items.map((item) => {
        const tone = item.tone ?? "neutral";
        return (
          <li key={item.id} className="tr-timeline__item">
            <span
              className={cx("tr-timeline__dot", tone !== "neutral" && `tr-timeline__dot--${tone}`)}
              aria-hidden="true"
            >
              {item.icon ?? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  focusable="false"
                >
                  {GLYPHS[tone]}
                </svg>
              )}
            </span>
            <div>
              <div className="tr-timeline__when">{item.when}</div>
              <div className="tr-timeline__title">{item.title}</div>
              {item.detail ? <div className="tr-timeline__detail">{item.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
