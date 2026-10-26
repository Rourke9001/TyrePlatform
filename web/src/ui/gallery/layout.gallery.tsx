import { LayoutSamples } from "./layout.demo";
import type { GallerySection } from "./types";

export const section: GallerySection = {
  id: "layout",
  title: "Layout: page header, tabs, sheets, dialog, shells",
  render: () => <LayoutSamples />,
};
