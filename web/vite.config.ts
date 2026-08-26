import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// No service worker and no PWA plugin here. ADR-0009 settled the sync design as
// online-first with a durable submit outbox, so what protects an in-progress
// inspection is IndexedDB and the outbox's own retry — never a cache and never
// Background Sync, which iOS Safari does not have. An installable manifest
// would add reach, not durability, and nothing in the capture flow waits on
// one.
export default defineConfig({
  plugins: [react()],
  // Stamped from package.json so a deployed bundle traces back to a release
  // (NFR-OBS-004). This file is the vitest config too, so the define reaches
  // tests; npm sets the variable for `npm test` and `npm run build` alike.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  server: {
    // Same-origin /api in dev; `make api-run` serves :8080. Keeping the
    // browser origin-clean means no CORS configuration to un-learn later.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  test: {
    // Components could not be rendered in a test before this: Vitest defaults
    // to the node environment, which has no document.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // e2e/ belongs to Playwright, whose specs need a live stack; vitest
    // matching *.spec.ts would try to run them in jsdom and fail on import.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
