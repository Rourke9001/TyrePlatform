import type { ReactNode } from "react";

// What a lane's src/ui/gallery/<group>.gallery.tsx exports as `section`
// (TYRE-447). Sections sort by id; render runs once per theme column.
export interface GallerySection {
  id: string;
  title: string;
  render: () => ReactNode;
}
