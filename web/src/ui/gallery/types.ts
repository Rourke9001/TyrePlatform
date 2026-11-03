import type { ReactNode } from "react";

// What src/ui/gallery/<group>.gallery.tsx exports as `section` (TYRE-447).
// Sections sort by id; render runs once per theme column. A *.gallery.tsx
// exports only `section` (react-refresh/only-export-components), so a
// stateful sample lives in a sibling *.demo.tsx.
export interface GallerySection {
  id: string;
  title: string;
  render: () => ReactNode;
}
