import { DamageNote } from "../DamageNote";
import { PhotoCapture, type Photo, type PhotoState } from "../PhotoCapture";
import { PhotoGallery, type GalleryPhoto } from "../PhotoGallery";
import type { GallerySection } from "./types";

// A placeholder picture: shapes in the default fill at partial opacity, so
// the sample needs no colour of its own (TYRE-445's colour gate).
const SAMPLE =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 30'>" +
      "<rect width='40' height='30' fill-opacity='.12'/>" +
      "<circle cx='20' cy='15' r='11' fill-opacity='.45'/>" +
      "<circle cx='20' cy='15' r='5' fill-opacity='.2'/>" +
      "</svg>",
  );

const ignore = () => undefined;

// Gallery samples, not a fleet: the subject and captions are made up.
const SUBJECT = "LINK-A position 3";
const REASON = "Show the cut on the sidewall.";

const STATES: PhotoState[] = ["saved", "waiting", "sending", "sent", "failed"];
const PHOTOS: Photo[] = STATES.map((state) => ({ id: state, src: SAMPLE, state }));

const GALLERY: GalleryPhoto[] = [
  { id: "a", src: SAMPLE, caption: "LINK-A position 3", meta: "Sample driver, 07:42" },
  { id: "b", src: SAMPLE, caption: "LINK-A position 4", meta: "Sample driver, 07:44" },
  { id: "c", src: SAMPLE, caption: "LINK-B spare" },
];

// FR-INS-024: a tenant's damage types arrive as configuration; these are
// the sample's own.
const DAMAGE = [
  { value: "CUT", label: "Cut" },
  { value: "BULGE", label: "Bulge" },
  { value: "BEAD", label: "Bead damage" },
  { value: "OTHER", label: "Something else" },
];

// Static on purpose. A *.gallery.tsx exports only its section object
// (react-refresh/only-export-components), so a stateful demo would live in
// a sibling photos.demo.tsx. PhotoGallery keeps its own state, so its
// viewer opens here.
export const section: GallerySection = {
  id: "photos",
  title: "Photos and damage",
  render: () => (
    <div className="tr-stack">
      <PhotoCapture photos={[]} onAdd={ignore} required reason={REASON} subject={SUBJECT} />
      <PhotoCapture
        photos={PHOTOS}
        onAdd={ignore}
        onRemove={ignore}
        reason={REASON}
        subject={SUBJECT}
      />
      <PhotoCapture photos={[]} onAdd={ignore} required subject={SUBJECT} storageLow />
      <PhotoGallery photos={GALLERY} />
      <PhotoGallery photos={[]} empty="No photo was required." />
      <DamageNote types={DAMAGE} type="CUT" onTypeChange={ignore} note="" onNoteChange={ignore} />
    </div>
  ),
};
