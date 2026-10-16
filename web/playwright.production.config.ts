import { defineConfig, devices } from "@playwright/test";

import { TEST_API_ORIGIN } from "./e2e/productionApi";

// The one config that runs a production build: vite preview of dist, served
// with the deploy's headers and a config.json the deploy's own writer fills
// in. A production bundle has only the bearer path, so every identity
// provider and API call is fulfilled in the spec (e2e/idp.ts,
// e2e/productionApi.ts). Section 4 of
// docs/superpowers/specs/2026-10-16-platform-readiness-design.md.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /production\.spec/,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "production", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && node ../scripts/write-web-config.mjs --api-origin ${TEST_API_ORIGIN} --dist dist && npx vite preview --port 4173 --strictPort`,
    url: "http://localhost:4173",
    // A preview left running would serve an older build.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
