import { useRef, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
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

// TODO(TYRE-447): these glyphs move to src/ui/icons/ when lane A's icon modules land.
const PATHS = {
  camera: ["M4 8.5h3l2-3h6l2 3h3v11H4z", "M15.5 13.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z"],
  device: [
    "M8.5 2.5h7a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z",
    "M11 18.5h2",
  ],
  wifi: [
    "M2.5 9a14 14 0 0 1 19 0",
    "M5.5 12.5a9.5 9.5 0 0 1 13 0",
    "M8.5 16a5 5 0 0 1 7 0",
    "M12 19.5h.01",
  ],
  "cloud-up": [
    "M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.6 4.5 4.5 0 0 0 7 18.5z",
    "M12 16.5v-5M9.6 13.6L12 11.2l2.4 2.4",
  ],
  "cloud-check": [
    "M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.6 4.5 4.5 0 0 0 7 18.5z",
    "M9.5 13.8l2 2 3.5-3.6",
  ],
  critical: ["M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z", "M12 7.5v5.5", "M12 16.5h.01"],
  close: ["M6 6l12 12M18 6L6 18"],
} as const;

function Glyph({ name, size }: { name: keyof typeof PATHS; size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

// NFR-USE-009: each state in words, the glyph only beside them.
const PHOTO_STATE: Record<PhotoState, { glyph: keyof typeof PATHS; label: string }> = {
  saved: { glyph: "device", label: "On phone" },
  waiting: { glyph: "wifi", label: "Needs Wi-Fi" },
  sending: { glyph: "cloud-up", label: "Sending" },
  sent: { glyph: "cloud-check", label: "Sent" },
  failed: { glyph: "critical", label: "Not sent yet" },
};

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
        if (files.length > 0) onAdd(files.slice(0, room));
        e.currentTarget.value = "";
      }}
    />
  );

  if (storageLow) {
    return (
      <div {...rest} className={cx("tr-photos", "tr-photos--ask", className)} role="status">
        <span className="tr-photos__askicon" aria-hidden="true">
          <Glyph name="device" size={22} />
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
          <Glyph name="camera" size={22} />
        </span>
        <div>
          <div className="tr-photos__title">Photo needed</div>
          {reason ? <div className="tr-photos__reason">{reason}</div> : null}
        </div>
        {/* TODO(TYRE-447): becomes lane A's glove Button when it lands. */}
        <button type="button" className="tr-photos__take" onClick={open}>
          <Glyph name="camera" size={22} />
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
                <Glyph name={s.glyph} size={14} />
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
                    <Glyph name="close" size={16} />
                  </span>
                </button>
              ) : null}
            </li>
          );
        })}
        {room > 0 ? (
          <li>
            <button type="button" className="tr-photo tr-photo--add" onClick={open}>
              <Glyph name="camera" size={24} />
              <span>{photos.length > 0 ? "Another" : "Add photo"}</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
