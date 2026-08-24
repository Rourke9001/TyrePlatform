import { defineConfig, devices } from "@playwright/test";

// E2E runs against the DEV server on purpose: identity comes from the dev
// actor headers (src/api/devTenant.ts), which exist only when
// import.meta.env.DEV is true — there is no real identity provider yet
// (FR-AUT-001), so a production build has no way to be anyone. The API must
// already be listening on :8080 with APP_DEV_TENANT_HEADER=1 over a seeded
// database; `make e2e` checks that before it launches anything.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A stray test.only would silently shrink the suite to one test in CI —
  // the same silent-gate failure mode TYRE-49 exists to prevent.
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  // One desktop browser is the smoke tier. Mobile-viewport projects arrive
  // with the capture app (TYRE-4), where the three-minute constraint
  // (NFR-USE-001) is the thing under test.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
