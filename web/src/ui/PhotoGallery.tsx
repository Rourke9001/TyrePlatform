import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import "./PhotoGallery.css";

export interface GalleryPhoto {
  id: string;
  src: string;
  // What it shows: "LINK-A position 3". Names the photo and its viewer.
  caption: string;
  // Who and when, already formatted by the caller (rule 6).
  meta?: string;
}

export interface PhotoGalleryProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  photos: readonly GalleryPhoto[];
  // Shown when there are none; the caller says whether one was required.
  empty?: ReactNode;
}

// TODO(TYRE-447): these glyphs move to src/ui/icons/ when lane A's icon modules land.
const PATHS = {
  "chevron-left": "M15 5l-7 7 7 7",
  "chevron-right": "M9 5l7 7-7 7",
  close: "M6 6l12 12M18 6L6 18",
} as const;

function Glyph({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function PhotoGallery({
  photos,
  empty = "No photos.",
  className,
  ...rest
}: PhotoGalleryProps) {
  const [open, setOpen] = useState<number | null>(null);
  // The thumbnail that opened the viewer, which takes focus back on close.
  const opener = useRef<HTMLButtonElement | null>(null);
  const count = photos.length;

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        opener.current?.focus();
      } else if (e.key === "ArrowRight") {
        setOpen((i) => (i === null ? i : (i + 1) % count));
      } else if (e.key === "ArrowLeft") {
        setOpen((i) => (i === null ? i : (i - 1 + count) % count));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, count]);

  if (count === 0) {
    return (
      <p {...rest} className={cx("tr-photo-gallery__empty", className)}>
        {empty}
      </p>
    );
  }

  const close = () => {
    setOpen(null);
    opener.current?.focus();
  };
  const step = (by: number) => setOpen((i) => (i === null ? i : (i + by + count) % count));
  const current = open === null ? null : photos[open];

  return (
    <>
      <ul {...rest} className={cx("tr-photo-gallery", className)}>
        {photos.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              className="tr-photo-gallery__item"
              aria-label={`Open photo: ${p.caption}`}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setOpen(i);
              }}
            >
              <img src={p.src} alt="" />
            </button>
            <span className="tr-photo-gallery__cap">{p.caption}</span>
            {p.meta ? <span className="tr-photo-gallery__meta">{p.meta}</span> : null}
          </li>
        ))}
      </ul>
      {current ? (
        // TODO(TYRE-447): trap Tab inside the viewer with lane B's focusTrap.ts when it lands.
        <div
          className="tr-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={current.caption}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <img src={current.src} alt={current.caption} />
          <div className="tr-viewer__bar">
            <span>
              <b>{current.caption}</b>
              {current.meta ? ` · ${current.meta}` : ""}
            </span>
            <span className="tr-viewer__tools">
              {count > 1 ? (
                <>
                  <button
                    type="button"
                    className="tr-viewer__btn"
                    aria-label="Previous photo"
                    onClick={() => step(-1)}
                  >
                    <Glyph name="chevron-left" />
                  </button>
                  <button
                    type="button"
                    className="tr-viewer__btn"
                    aria-label="Next photo"
                    onClick={() => step(1)}
                  >
                    <Glyph name="chevron-right" />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="tr-viewer__btn"
                aria-label="Close"
                onClick={close}
                autoFocus
              >
                <Glyph name="close" />
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
