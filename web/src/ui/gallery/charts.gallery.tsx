import { ChartSamples } from "./charts.demo";
import type { GallerySection } from "./types";

export const section: GallerySection = {
  id: "charts",
  title: "Charts: tread bands and provenance",
  render: () => <ChartSamples />,
};
