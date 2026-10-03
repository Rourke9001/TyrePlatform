import { defineConfig, devices } from "@playwright/test";

// E2E runs against the DEV server on purpose, because in every project but
// auth identity is the dev actor headers (src/api/devTenant.ts,
// import.meta.env.DEV only). The auth project signs in against a stubbed
// identity provider and swaps the bearer for the Sandbox dev headers on /api
// (e2e/idp.ts, the one mocking exception web/CLAUDE.md names). The API must
// be listening on :8080 with APP_DEV_TENANT_HEADER=1 over a seeded database;
// make e2e checks this first.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A stray test.only would silently shrink the suite to one test in CI.
  // That is the same silent-gate failure mode TYRE-49 exists to prevent.
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    // dashboard.spec.ts reads BAC and asserts the pinned 19, 11, 9 and
    // R16,537.50 (CLAUDE.md, the three-way agreement). capture.spec.ts
    // writes BAC on android, and fullyParallel would let that write land
    // mid-read, so android depends on this project (U50).
    {
      name: "bac-readonly",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /dashboard\.spec/,
    },
    // capture.spec.ts submits, and FR-INS-038's duplicate window is tenant
    // state in one shared database: a second project's submit is refused by
    // the first's. Gated here, not skipped inside the file: a skip still
    // launches a browser and builds a context per project.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /capture\.spec|dashboard\.spec|auth\.spec/,
    },
    // The capture app is judged at phone dimensions or not at all: thumb reach,
    // 44px targets and sunlight legibility are the design, not the styling.
    // Pixel 7 and iPhone 14 bracket the sizes a driver actually carries.
    //
    // admin.spec.ts, tyres.spec.ts, fitments.spec.ts and rotation.spec.ts
    // each create/dispose rows per run, so, like capture.spec.ts, they run on
    // one project only: a second project would repeat the writes, not the
    // assertions. rotation.spec.ts also drives a manager screen, judged at
    // desktop size.
    {
      name: "android",
      use: { ...devices["Pixel 7"] },
      dependencies: ["bac-readonly"],
      testIgnore:
        /admin\.spec|tyres\.spec|fitments\.spec|rotation\.spec|dashboard\.spec|auth\.spec/,
    },
    // iPhone 14 is WebKit, buying the second phone viewport and nothing more:
    // capture.spec.ts is ignored here since FR-INS-038's window is per unit
    // and the fixture has no spare unit for a second project, so the outbox
    // runs on android alone. TYRE-227 gives ios its own units; until then
    // FR-OFF-020's WebKit storage eviction is unexercised.
    {
      name: "ios",
      use: { ...devices["iPhone 14"] },
      testIgnore:
        /capture\.spec|admin\.spec|tyres\.spec|fitments\.spec|rotation\.spec|dashboard\.spec|auth\.spec/,
    },
    // Sign-in and sign-out against the stub (TYRE-317). Its own Pixel 7
    // project so the bearer flag and the route stubs never touch the others,
    // and so its Sandbox submits run once.
    {
      name: "auth",
      use: { ...devices["Pixel 7"] },
      testMatch: /auth\.spec/,
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
