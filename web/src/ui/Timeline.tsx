import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { AlertIcon } from "./icons/Alert";
import { CheckIcon } from "./icons/Check";
import { ClockIcon } from "./icons/Clock";
import { CriticalIcon } from "./icons/Critical";
import "./Timeline.css";

type Tone = "ok" | "warn" | "critical" | "neutral";

const GLYPHS: Record<Tone, IconGlyph> = {
  ok: CheckIcon,
  warn: AlertIcon,
  critical: CriticalIcon,
  neutral: ClockIcon,
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
    // role="list" for WebKit, as DataTable.tsx's card list says.
    <ol role="list" className={cx("tr-timeline", className)} {...rest}>
      {items.map((item) => {
        const tone = item.tone ?? "neutral";
        return (
          <li key={item.id} className="tr-timeline__item">
            <span
              className={cx("tr-timeline__dot", tone !== "neutral" && `tr-timeline__dot--${tone}`)}
              aria-hidden="true"
            >
              {item.icon ?? <Icon icon={GLYPHS[tone]} size={14} />}
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
