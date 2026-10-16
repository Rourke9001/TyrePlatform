import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The production build downloads /config.json beside the entry rather than
// after it (NFR-PRF-001, ADR-0019). Build only: a dev build never fetches the
// file, so under vite dev the preload would be answered with index.html and
// the browser would warn that it went unused. crossorigin makes its mode and
// credentials match fetch's defaults, or the fetch would not consume it.
function preloadRuntimeConfig(): Plugin {
  return {
    name: "preload-runtime-config",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "link",
        attrs: { rel: "preload", as: "fetch", href: "/config.json", crossorigin: true },
        injectTo: "head",
      },
    ],
  };
}

// vite preview serves the deploy's own headers, so the production browser
// check (playwright.production.config.ts) runs the bundle under the CSP
// staging sends. The file is the writer's output, read when preview starts;
// vite dev, vite build and vitest never read it (ADR-0019).
function previewHeaders(): Record<string, string> {
  const file = fileURLToPath(new URL("./dist/staticwebapp.config.json", import.meta.url));
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: run scripts/write-web-config.mjs after the build`);
  }
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    globalHeaders: Record<string, string>;
  };
  return config.globalHeaders;
}

// No service worker or PWA plugin: ADR-0009 protects an in-progress
// inspection with IndexedDB and the outbox's own retry, never a cache or
// Background Sync, which iOS Safari lacks. An installable manifest would add
// reach, not durability.
export default defineConfig(({ isPreview }) => ({
  plugins: [react(), preloadRuntimeConfig()],
  // Stamped from package.json so a deployed bundle traces back to a release
  // (NFR-OBS-004). This file is the vitest config too, so the define reaches
  // tests; npm sets the variable for `npm test` and `npm run build` alike.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  server: {
    // Same-origin /api in dev; `make api-run` serves :8080. A dev build never
    // reads config.json, so its paths stay relative and reach the API here
    // (ADR-0019).
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  // The bundle gate reads which chunks the entry statically imports; nothing
  // else needs the manifest (TYRE-238, ADR-0015).
  build: { manifest: true },
  ...(isPreview ? { preview: { headers: previewHeaders() } } : {}),
  test: {
    // Components could not be rendered in a test before this: Vitest defaults
    // to the node environment, which has no document.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // brandConfinement.test.ts reads the stylesheets as text (U53); vitest
    // stubs a CSS import to "" unless it is listed here, ?raw included.
    css: { include: [/\.css\?raw$/] },
    // e2e/ belongs to Playwright, whose specs need a live stack; vitest
    // matching *.spec.ts would try to run them in jsdom and fail on import.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
}));
