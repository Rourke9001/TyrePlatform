import { useRef, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import { CameraIcon } from "./icons/Camera";
import { CloseIcon } from "./icons/Close";
import { CloudCheckIcon } from "./icons/CloudCheck";
import { CloudUpIcon } from "./icons/CloudUp";
import { CriticalIcon } from "./icons/Critical";
import { DeviceIcon } from "./icons/Device";
import { WifiIcon } from "./icons/Wifi";
import "./PhotoCapture.css";

// saved: compressed and held on the phone. waiting: held for Wi-Fi
// (FR-OFF-019). sending, sent, failed: the photo queue, apart from the
// readings (FR-OFF-018).
export type PhotoState = "saved" | "waiting" | "sending" | "sent" | "failed";

export interface Photo {
  id: string;
  // An object URL or data URL of the compressed image.
  src: string;
  state: PhotoState;
}

export interface PhotoCaptureProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  photos: readonly Photo[];
  // The camera's files. The caller compresses them before queueing
  // (FR-OFF-017).
  onAdd: (files: File[]) => void;
  onRemove?: (id: string) => void;
  // The tenant requires a photo here (FR-INS-039, configured by FR-CFG-020).
  required?: boolean;
  reason?: ReactNode;
  // Names the position in each photo's alt text: "LINK-A position 3".
  subject: string;
  // The tenant's cap on photos, if it sets one (rule 5).
  max?: number;
  // FR-OFF-008: short of space, capture defers instead of blocking.
  storageLow?: boolean;
}

// NFR-USE-009: each state in words, the glyph only beside them.
const PHOTO_STATE: Record<PhotoState, { glyph: IconGlyph; label: string }> = {
  saved: { glyph: DeviceIcon, label: "On phone" },
  waiting: { glyph: WifiIcon, label: "Needs Wi-Fi" },
  sending: { glyph: CloudUpIcon, label: "Sending" },
  sent: { glyph: CloudCheckIcon, label: "Sent" },
  failed: { glyph: CriticalIcon, label: "Not sent yet" },
};

// A driver control by design (TYRE-152, TYRE-448), so every control in it is
// the glove target. It is on the capture entry's forbidden list on this
// branch only because no capture route renders it yet (spec, non-goals).
export function PhotoCapture({
  photos,
  onAdd,
  onRemove,
  required,
  reason,
  subject,
  max,
  storageLow,
  className,
  ...rest
}: PhotoCaptureProps) {
  const input = useRef<HTMLInputElement>(null);
  const open = () => input.current?.click();
  const room = max === undefined ? Infinity : Math.max(0, max - photos.length);
  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      capture="environment"
      className="tr-vh"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        if (room > 0 && files.length > 0) onAdd(files.slice(0, room));
        e.currentTarget.value = "";
      }}
    />
  );

  if (storageLow) {
    return (
      <div {...rest} className={cx("tr-photos", "tr-photos--ask", className)} role="status">
        <span className="tr-photos__askicon" aria-hidden="true">
          <Icon icon={DeviceIcon} size={22} />
        </span>
        <div>
          <div className="tr-photos__title">Not enough space for photos</div>
          <div className="tr-photos__reason">
            Keep reading. The office will ask for this photo later.
          </div>
        </div>
      </div>
    );
  }

  if (required && photos.length === 0) {
    return (
      <div {...rest} className={cx("tr-photos", "tr-photos--ask", className)}>
        {picker}
        <span className="tr-photos__askicon" aria-hidden="true">
          <Icon icon={CameraIcon} size={22} />
        </span>
        <div>
          <div className="tr-photos__title">Photo needed</div>
          {reason ? <div className="tr-photos__reason">{reason}</div> : null}
        </div>
        {/* TODO(TYRE-447): becomes lane A's glove Button when it lands. */}
        <button type="button" className="tr-photos__take" onClick={open}>
          <Icon icon={CameraIcon} size={22} />
          <span>Take photo</span>
        </button>
      </div>
    );
  }

  return (
    <div {...rest} className={cx("tr-photos", className)}>
      {picker}
      <div className="tr-photos__head">
        <span className="tr-photos__title">
          Photos <span className="tr-mono">{photos.length}</span>
        </span>
        {reason ? <span className="tr-photos__reason">{reason}</span> : null}
      </div>
      <ul className="tr-photos__strip">
        {photos.map((p, i) => {
          const s = PHOTO_STATE[p.state];
          return (
            <li key={p.id} className="tr-photo">
              <img src={p.src} alt={`Photo ${i + 1} of ${subject}`} />
              <span className={cx("tr-photo__state", `tr-photo__state--${p.state}`)}>
                <Icon icon={s.glyph} size={14} />
                {s.label}
              </span>
              {onRemove ? (
                <button
                  type="button"
                  className="tr-photo__remove"
                  aria-label={`Remove photo ${i + 1}`}
                  onClick={() => onRemove(p.id)}
                >
                  <span>
                    <Icon icon={CloseIcon} size={16} />
                  </span>
                </button>
              ) : null}
            </li>
          );
        })}
        {room > 0 ? (
          <li>
            <button type="button" className="tr-photo tr-photo--add" onClick={open}>
              <Icon icon={CameraIcon} size={24} />
              <span>{photos.length > 0 ? "Another" : "Add photo"}</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
