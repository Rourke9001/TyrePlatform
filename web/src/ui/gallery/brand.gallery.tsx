import type { CSSProperties } from "react";

import { BrandMark } from "../BrandMark";
import { Icon, type IconGlyph } from "../Icon";
import type { GallerySection } from "./types";

// Every glyph module, so a new icon shows here with no edit. Each cell
// shows the export a screen imports.
const glyphs = Object.entries(
  import.meta.glob<Record<string, IconGlyph>>("../icons/*.tsx", { eager: true }),
)
  .map(([path, mod]) => {
    const name = `${/(\w+)\.tsx$/.exec(path)?.[1] ?? path}Icon`;
    return { name, glyph: mod[name] };
  })
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(6.5rem, 1fr))",
  gap: "var(--space-3)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const cell: CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
  fontSize: "var(--type-caption-size)",
  lineHeight: "var(--type-caption-line)",
  color: "var(--ink-secondary)",
};

// U53: the on-brand mark and icon button show on the shells' brand band,
// so no brand fill is drawn here outside the allowlisted chrome.
export const section: GallerySection = {
  id: "brand",
  title: "Brand and icons: the tenant's mark and Tread's glyphs",
  render: () => (
    <div className="tr-stack">
      <div className="tr-cluster">
        <BrandMark name="Sandbox Fleet" logoUrl={null} subtitle="Main depot" />
        <BrandMark name="Sandbox Fleet" logoUrl={null} size="sm" />
        <BrandMark name="Sandbox" logoUrl={null} showName={false} />
      </div>
      <ul style={grid} aria-label="Icons">
        {glyphs.map(({ name, glyph }) => (
          <li key={name} style={cell}>
            <Icon icon={glyph} size={24} />
            <span className="tr-mono">{name}</span>
          </li>
        ))}
      </ul>
    </div>
  ),
};
