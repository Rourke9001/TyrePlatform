import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PWA config (vite-plugin-pwa, offline queue, Background Sync strategy) is
// deliberately absent until Q7 answers the driver-device question: iOS Safari
// has no Background Sync API, and that decides the sync design (see TYRE-4).
export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin /api in dev; `make api-run` serves :8080. Keeping the
    // browser origin-clean means no CORS configuration to un-learn later.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
