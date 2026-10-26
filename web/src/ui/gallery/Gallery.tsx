import { useId } from "react";

import type { GallerySection } from "./types";
import "./gallery.css";

// A lane registers a section by adding src/ui/gallery/<group>.gallery.tsx,
// so no two lanes edit one file to show their components (TYRE-447).
const registered = Object.values(
  import.meta.glob<{ section: GallerySection }>("./*.gallery.tsx", { eager: true }),
).map((module) => module.section);

const COLUMNS = [
  { theme: "light", label: "Daylight" },
  { theme: "dark", label: "Night shift" },
] as const;

function Column({
  theme,
  label,
  sections,
}: {
  theme: "light" | "dark";
  label: string;
  sections: readonly GallerySection[];
}) {
  const id = useId();
  return (
    <section data-theme={theme} className="tr-gallery__column" aria-labelledby={id}>
      <h2 id={id} className="tr-gallery__theme">
        {label}
      </h2>
      {sections.length === 0 ? (
        <p>No sections yet.</p>
      ) : (
        sections.map((section) => (
          <article
            key={section.id}
            className="tr-gallery__section"
            aria-labelledby={`${id}-${section.id}`}
          >
            <h3 id={`${id}-${section.id}`} className="tr-gallery__title">
              {section.title}
            </h3>
            {section.render()}
          </article>
        ))
      )}
    </section>
  );
}

// Each section renders in a Daylight and a Night shift column at once, so
// a component is reviewed in both themes side by side (ADR-0020).
export function GalleryView({ sections }: { sections: readonly GallerySection[] }) {
  const sorted = [...sections].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return (
    <div className="tr-gallery">
      <h1 className="tr-gallery__heading">Design gallery</h1>
      <div className="tr-gallery__columns">
        {COLUMNS.map(({ theme, label }) => (
          <Column key={theme} theme={theme} label={label} sections={sorted} />
        ))}
      </div>
    </div>
  );
}

// Dev only: routes.tsx folds the route away in a production build.
export default function Gallery() {
  return <GalleryView sections={registered} />;
}
