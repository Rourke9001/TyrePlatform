import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import { useFocusTrap } from "./focusTrap";
import { Icon } from "./Icon";
import { ChevronLeftIcon } from "./icons/ChevronLeft";
import { ChevronRightIcon } from "./icons/ChevronRight";
import { CloseIcon } from "./icons/Close";
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

  const viewer = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  // The trap owns Escape, Tab and the focus return to the thumbnail.
  const isOpen = open !== null;
  useFocusTrap(viewer, isOpen, () => setOpen(null), opener);

  // The trap puts focus on the panel as it opens; Close is where a
  // keyboard user starts, and this effect runs after the trap's.
  useEffect(() => {
    if (isOpen) closeButton.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
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

  const close = () => setOpen(null);
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
        <div
          ref={viewer}
          tabIndex={-1}
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
                    <Icon icon={ChevronLeftIcon} />
                  </button>
                  <button
                    type="button"
                    className="tr-viewer__btn"
                    aria-label="Next photo"
                    onClick={() => step(1)}
                  >
                    <Icon icon={ChevronRightIcon} />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="tr-viewer__btn"
                aria-label="Close"
                onClick={close}
                ref={closeButton}
              >
                <Icon icon={CloseIcon} />
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
