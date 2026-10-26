import { DataSamples } from "./data.demo";
import type { GallerySection } from "./types";

export const section: GallerySection = {
  id: "data",
  title: "Data: figures, cards, rows, tables, history, progress",
  render: () => <DataSamples />,
};
