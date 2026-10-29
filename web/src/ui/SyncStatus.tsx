import type { HTMLAttributes } from "react";

import { groupThousands } from "../format/groupThousands";
import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { CloudCheckIcon } from "./icons/CloudCheck";
import { CloudOffIcon } from "./icons/CloudOff";
import { CloudUpIcon } from "./icons/CloudUp";
import { CriticalIcon } from "./icons/Critical";
import { DeviceIcon } from "./icons/Device";
import "./SyncStatus.css";

// sent: nothing held on the phone. saved: the open inspection is held on
// the phone. sending, waiting and failed: the submit outbox (ADR-0009).
export type SyncState = "sent" | "saved" | "sending" | "waiting" | "failed";

const SYNC: Record<SyncState, { icon: IconGlyph; words: (n: string, count: number) => string }> = {
  sent: { icon: CloudCheckIcon, words: () => "All sent" },
  saved: { icon: DeviceIcon, words: () => "Saved on phone" },
  sending: { icon: CloudUpIcon, words: (n, count) => (count > 1 ? `Sending ${n}` : "Sending") },
  waiting: { icon: CloudOffIcon, words: (n) => `${n} waiting for signal` },
  failed: {
    icon: CriticalIcon,
    words: (n, count) => `${n} need${count === 1 ? "s" : ""} the office`,
  },
};

export interface SyncStatusProps extends Omit<HTMLAttributes<HTMLElement>, "onClick"> {
  state: SyncState;
  count?: number;
  // Makes the chip a button that opens the outbox.
  onClick?: () => void;
  // Replaces the default words, keeping the glyph and tone.
  label?: string;
}

// The live region wraps the chip, button or not, so it stays in the page
// when onClick comes or goes and a change of state is announced without
// the driver looking (NFR-USE-010).
export function SyncStatus({
  state,
  count = 1,
  onClick,
  label,
  className,
  ...rest
}: SyncStatusProps) {
  const s = SYNC[state];
  const classes = cx("tr-sync", `tr-sync--${state}`, className);
  const content = (
    <>
      <span className="tr-sync__dot" aria-hidden="true">
        <Icon icon={s.icon} size={16} />
      </span>
      {label ?? s.words(groupThousands(String(count)), count)}
    </>
  );
  return (
    <span role="status">
      {onClick ? (
        <button {...rest} type="button" className={classes} onClick={onClick}>
          {content}
        </button>
      ) : (
        <span {...rest} className={classes}>
          {content}
        </span>
      )}
    </span>
  );
}
