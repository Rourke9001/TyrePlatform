import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

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
  // The open photo by id, so a refetch that reorders the list keeps it.
  const [open, setOpen] = useState<string | null>(null);
  // The thumbnail that opened the viewer, which takes focus back on close.
  const opener = useRef<HTMLButtonElement | null>(null);
  const count = photos.length;
  const at = open === null ? -1 : photos.findIndex((p) => p.id === open);
  // A refetch or a removal can take the open photo away. The viewer closes
  // with it, or its trap holds Tab on a viewer that is gone (WCAG 2.1.2).
  if (open !== null && at === -1) setOpen(null);
  const current = at === -1 ? null : photos[at];

  const viewer = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  // The trap owns Escape, Tab and the focus return to the thumbnail.
  const isOpen = current !== null;
  useFocusTrap(viewer, isOpen, () => setOpen(null), opener);

  // The trap puts focus on the panel as it opens; Close is where a
  // keyboard user starts, and this effect runs after the trap's.
  useEffect(() => {
    if (isOpen) closeButton.current?.focus();
  }, [isOpen]);

  const step = (by: number) => {
    if (at !== -1) setOpen(photos[(at + by + count) % count].id);
  };
  const onArrow = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  });
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => onArrow(e);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  if (count === 0) {
    return (
      <p {...rest} className={cx("tr-photo-gallery__empty", className)}>
        {empty}
      </p>
    );
  }

  const close = () => setOpen(null);

  return (
    <>
      <ul {...rest} className={cx("tr-photo-gallery", className)}>
        {photos.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="tr-photo-gallery__item"
              aria-label={`Open photo: ${p.caption}`}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setOpen(p.id);
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
