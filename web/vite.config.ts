import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PWA config (vite-plugin-pwa, service worker) arrives with the capture app
// (TYRE-4). ADR-0009 settled the sync design: online-first with a durable
// submit outbox — never Background Sync, which iOS Safari does not have.
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
