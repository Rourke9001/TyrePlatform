// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { themes } from "../src/theme/tokens";

// TYRE-154: the manifest and icons are static files. The tests live here, not
// in src/, because the app's tsconfig has no node types to read public/.
const PUBLIC = resolve(import.meta.dirname, "../public");
const INDEX = resolve(import.meta.dirname, "../index.html");
const read = (path: string) => readFileSync(resolve(PUBLIC, path));
const manifest = JSON.parse(read("manifest.webmanifest").toString("utf8")) as {
  icons: { src: string; sizes: string }[];
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(file: string): { signature: number[]; size: [number, number] } {
  const buf = read(file);
  return {
    signature: [...buf.subarray(0, 8)],
    size: [buf.readUInt32BE(16), buf.readUInt32BE(20)],
  };
}

describe("the web-app manifest", () => {
  it("declares the app as spec section 1's table, no more", () => {
    expect(manifest).toEqual({
      name: "Tyre Track",
      short_name: "Tyre Track",
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: themes.light.canvas,
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        {
          src: "/icons/icon-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    });
  });

  it("ships every icon it names, and the touch icon, as a PNG of the declared size", () => {
    for (const icon of manifest.icons) {
      const file = icon.src.replace(/^\//, "");
      const want = icon.sizes.split("x").map(Number);
      const got = pngSize(file);
      expect(got.signature, `public/${file}`).toEqual(SIGNATURE);
      expect(got.size, `public/${file}`).toEqual(want);
    }
    const touch = pngSize("icons/apple-touch-icon.png");
    expect(touch.signature, "public/icons/apple-touch-icon.png").toEqual(SIGNATURE);
    expect(touch.size, "public/icons/apple-touch-icon.png").toEqual([180, 180]);
  });

  it("links the manifest and the touch icon, and names the app, in index.html", () => {
    const doc = new DOMParser().parseFromString(readFileSync(INDEX, "utf8"), "text/html");
    expect(doc.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
      "/manifest.webmanifest",
    );
    expect(doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/icons/apple-touch-icon.png",
    );
    expect(
      doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content"),
    ).toBe("Tyre Track");
    expect(doc.title).toBe("Tyre Track");
  });
});
