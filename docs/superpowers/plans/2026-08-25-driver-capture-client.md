# Driver Capture — Client Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a driver a phone screen that captures a whole vehicle in under three minutes, holds the inspection durably until the server acknowledges it, and warns them at the point of entry using thresholds the tenant configured — closing the `INS` and `OFF` modules and proving M2.

**Architecture:** Online-first with a durable submit outbox (ADR-0009) — not an offline sync engine. Reference data is fetched once per session and held **in memory only**; the one thing written to the device is the in-progress inspection. Every rule that decides something is a pure function with a vitest, and the React components are a thin shell over them: the warning engine, the keypad reducer and the outbox state machine each hold their logic where it can be tested without a browser.

**Tech Stack:** React 19 + Vite 7, TypeScript `strict`, Tanstack Query for server state, Dexie over IndexedDB for the outbox (first use in this repo), vitest + Testing Library, Playwright for the mobile-viewport tier.

**Spec:** `docs/superpowers/specs/2026-08-25-driver-capture-and-outbox-design.md` — read it first. This plan argues from it.

**Depends on:** `docs/superpowers/plans/2026-08-25-driver-capture-server.md` must be complete and merged. Task 2 of this plan consumes `GET /api/capture/vehicles/{id}` and Task 8 consumes `POST /api/inspections`; neither exists until the server slice lands.

**Tickets:** TYRE-68 (Task 1) · TYRE-69 (Tasks 2–11) · TYRE-70 (Task 12), under epic TYRE-4.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a bug even if tests pass.

- **The three-minute constraint outranks everything here.** NFR-USE-001: a trained driver completes a ten-position vehicle in a median of **3 minutes or less**; NFR-USE-001a: a 26-position rig in **7 minutes or less**. Three readings per position makes a superlink **108 numeric entries**. Before adding anything to the capture flow, count the taps it costs — three seconds per position is over a minute on a superlink.
- **No `any`.** `strict: true`, and `@typescript-eslint/no-explicit-any` is an error. If you reach for `any`, the type is wrong.
- **Colours and type come from `web/src/theme/tokens.ts` only**, consumed as CSS custom properties. A hex or font literal in a `.tsx` or a new `.css` is a bug. Tread band colours are keyed to band **names**; the mm thresholds that assign a band are tenant configuration and never appear in this codebase.
- **Every threshold, band, margin, multiple and ceiling is fetched tenant configuration.** If you are about to type `4.0`, `3`, `25` or `1600` in `web/src/`, stop — it belongs in the capture context payload. This is CLAUDE.md rule 5 and it is the rule most likely to be broken by this slice.
- **Never convey information by colour alone** (NFR-USE-009). Every severity carries colour **and** background **and** a text badge.
- **Nothing is ever labelled a legal limit** (CR-010, OR-LEG-001). The platform reports the tenant's configured policy. The words "legal", "roadworthy" and "minimum" do not appear next to a threshold.
- **Natural sort, never lexicographic** (NFR-USE-012): `POS2` before `POS10`.
- **Rig-level position numbers are display only** (BR-VEH-003, FR-VEH-034). They are computed at render time from the composition and **never transmitted**. Every reading is submitted against `vehicle_id + position_id`.
- **Reference data is session-memory only** (FR-OFF-002). It is never written to IndexedDB, `localStorage` or `sessionStorage`. The only thing at rest on the device is the in-progress inspection (NFR-PRV-006 requires us to be able to say exactly that to a driver).
- **Prettier owns layout.** Do not hand-format. `make fmt` before `make lint`.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code. Cite the requirement ID (`FR-INS-036`, `BR-ANL-009`) for any non-obvious rule. `TODO` needs a ticket ID on the same line.
- **Run `make check` before every commit.** Docker must be running for the db and api tiers.

## Requirement values, copied verbatim

Do not paraphrase these into the code; they are the acceptance criteria.

| ID | Text |
| --- | --- |
| FR-INS-029a | "The capture screen presents reading fields **left-to-right in the plan view**; the system maps them to outer/centre/inner **by the position's side of the vehicle** on save. **The driver never sees the words inner or outer.**" |
| FR-INS-034 | "warn and require confirmation where a governing tread reading is greater than the previous governing reading for the same tyre, **unless a fitment event since the previous reading explains the increase**" |
| FR-INS-035 | "warn and require confirmation where a tread reading implies a wear rate exceeding a configurable multiple of the fleet average for that position class, **defaulting to three times**" |
| FR-INS-036 | "warn immediately, within the capture flow, when an entered tread depth is below the configured policy threshold (**never labelled as a legal limit**)" |
| FR-INS-037 | "warn immediately, within the capture flow, when an entered pressure falls outside the configured correct band" |
| FR-INS-040 | "record **every** validation warning that was raised and the user's response to it" |
| FR-INS-041 | "warn… where the spread between the highest and lowest width-wise readings at one position exceeds a configurable margin, defaulting to 4mm, and **shall prompt for a photograph**" |
| FR-INS-030 / 031 | "**reject** tread depth values outside the range 0 to 35 millimetres" / "**reject** pressure values outside the range 0 to 1,200 kilopascals" |
| FR-INS-062 | "require the driver to confirm which towed units are attached before beginning a rig inspection, **defaulting to the last recorded composition**" |
| FR-OFF-002 | "fetched at session start and cached **in memory for the session only** — not persisted at rest on the device" |
| FR-OFF-005 | "Every entry made during capture shall be written **incrementally** to a durable local buffer, and a submitted inspection shall be held in a durable **outbox** until confirmed accepted by the server." |
| FR-OFF-009 | "attempt to send the outbox automatically on app-open and whenever connectivity is restored **while the app is open**. It shall not depend on background sync." |
| FR-OFF-012 | "retry a failed submit with exponential backoff to a maximum interval of **30 minutes** while the app is open" |
| FR-OFF-013 | "**preserve** an inspection locally where submit fails permanently, and shall present the failure to the user with a **supported recovery action**" |
| FR-OFF-014 | "**never** silently discard a buffered or queued inspection under any circumstance" |
| FR-OFF-020 | "warn the **driver** when an unsent inspection has waited in the outbox for approximately **two days**" |
| BR-ANL-007 | "`width_spread_mm = MAX(measurements) − MIN(measurements)` for one position at one inspection" |
| BR-ANL-009 | "cohort by `axle_type` and never blend… For **lifting** axles, **no wear rate is asserted**" |
| BR-INS-003 | "The governing tread depth for a tyre is the **minimum** of all width-wise readings taken at that inspection." |
| NFR-AVL-002 | "An inspection **in progress** shall survive any server unavailability… **Starting a new inspection requires the server.**" |
| NFR-PRF-002 | "respond to any position entry within **200 milliseconds**" |
| NFR-USE-010 | "present confirmation of successful submission **unambiguously**, given that drivers cannot be expected to infer success from absence of error" |
| NFR-USE-011 | "preserve all user input across accidental navigation or application backgrounding" |
| NFR-OBS-007 | "record **median time-per-position** at capture, so that the effect of the three-reading model on NFR-USE-001 is measured rather than assumed" |

## Decisions this plan takes

Three questions the SRS leaves to the implementation. Each is settled here so nobody re-derives it mid-task.

**D-A — the three tread fields are numbered, not named.** FR-INS-029a forbids the words inner and outer, and the Confluence prototype's `Outer / Centre / Inner` labels are therefore wrong and are not carried over. The three fields render **left to right in the plan view**, directly beneath a plan-view glyph of that tyre, labelled `1 · 2 · 3`. The ordinal is exactly what is transmitted, the training message is one sentence ("enter them left to right, the way the diagram shows"), and no vehicle-relative word appears on screen. Accessible names are `Tread reading 1 of 3`, etc.

**D-B — the plan view is the frame, not the driver's body.** Left-to-right means the vehicle seen from above, nose up — the same frame BR-VEH-001 numbers positions in and the same frame the axle diagram draws. It does **not** mean "as the driver stands at the tyre": a driver at a tyre faces it across the vehicle's fore-aft axis, so their left-to-right is not the width axis at all. The server maps ordinal → `OUTER`/`CENTRE`/`INNER` by side (`LEFT` position: 1 → `OUTER`; `RIGHT` position: 1 → `INNER`). **The client never sends a canonical position and never reverses anything.** It sends entry order.

**D-C — the capture app's leg of the three-way agreement is per-vehicle.** CLAUDE.md requires the database, the capture app and the dashboard to compute the Appendix J exception counts independently. The capture app does not compute a fleet count — it evaluates one vehicle at the moment of entry. Its leg is therefore pinned in Task 11: the e2e captures a known fixture vehicle and asserts the warnings the app raised match the exception rows the database holds for that vehicle. **The fleet-wide 19 / 11 / 9 agreement for clients lands with TYRE-41 and sub-project 5**, not here. Do not build a fixture export into `web/` to fake it — that would be a second copy of the golden fixture and a second authority.

## File Structure

| File | Responsibility |
| --- | --- |
| `web/src/shell/navigation.ts` | The capability → nav item registry. One source for the menu and the route guard. |
| `web/src/shell/navigation.test.ts` | Driver sees one item, org admin sees all, unknown capability never renders. |
| `web/src/dashboard/AppShell.tsx` | Renders the registry; responsive to a phone viewport. |
| `web/src/capture/captureContext.ts` | Wire types for `GET /api/capture/vehicles/{id}` and the session-memory loader. |
| `web/src/capture/warnings.ts` | The per-position warning rules (FR-INS-036/037/041/031a) and the severity name. Pure. |
| `web/src/capture/history.ts` | The history and odometer rules (FR-INS-034/035/032/033). Pure. |
| `web/src/capture/entry.ts` | The keypad reducer: digit accumulation, settle, auto-advance, hard ranges. Pure. |
| `web/src/capture/draft.ts` | Dexie: the single in-progress inspection, written per entry. |
| `web/src/capture/rig.ts` | FR-VEH-034's display projection: 1..n across member units, computed and discarded. |
| `web/src/capture/payload.ts` | Draft → `POST /api/inspections` body. Entry order preserved verbatim. |
| `web/src/capture/outbox.ts` | Dexie: the submit queue, backoff, permanent-vs-retryable classification. |
| `web/src/capture/Keypad.tsx` | The shared numeric keypad. No native keyboard anywhere in capture. |
| `web/src/capture/PositionSheet.tsx` | One position: plan-view glyph, three tread fields, pressure, live alerts. |
| `web/src/capture/CaptureDiagram.tsx` | Plan-view axle diagram; any-order completion by tapping a position. |
| `web/src/capture/CaptureStart.tsx` | Vehicle, attached units (FR-INS-062), odometer, the NFR-PRV-006 notice. |
| `web/src/capture/CaptureReview.tsx` | Summary, comment, defect report, submit. |
| `web/src/capture/CaptureDone.tsx` | Unambiguous success (NFR-USE-010) and outbox state. |
| `web/src/capture/OutboxIndicator.tsx` | Queue count, *Sync now*, the stale warning. Mounted in the shell. |
| `web/src/capture/CaptureFlow.tsx` | The screen state machine and the route entry point. |
| `web/src/capture/capture.css` | Capture-only layout. Tokens only. |
| `web/src/api/client.ts` | Add `apiPost` carrying the HTTP status as a typed error. |
| `web/e2e/capture.spec.ts` | Mobile-viewport flows, offline capture, restart, reconnect-and-sync. |
| `web/playwright.config.ts` | Mobile projects. |

**New dependencies.** Task 6 adds `dexie` (runtime) and `fake-indexeddb` (dev, so the draft and outbox tests run in jsdom); Task 10 adds `@testing-library/user-event` and `@testing-library/jest-dom` (dev). NFR-PRF-009 caps the first-load bundle at 500KB compressed — Dexie is roughly 25KB gzipped, which is affordable, but check the built size in Task 6 rather than assuming it.

---
### Task 1: Capability-driven navigation (TYRE-68)

`AppShell` already gates two links with `RequireCapability`, which is the right control but the wrong shape: the menu is a hard-coded list and every new surface means editing the shell. Make the list data, so navigation and the route guard read one source and a capability added later brings its item with it.

**Files:**
- Create: `web/src/shell/navigation.ts`
- Create: `web/src/shell/navigation.test.ts`
- Modify: `web/src/dashboard/AppShell.tsx` (nav block only)
- Modify: `web/src/dashboard/dashboard.css`

**Interfaces:**
- Consumes: `Me.capabilities: string[]` from `web/src/auth/me.ts` — already fetched by `ActorProvider`.
- Produces: `NavItem`, `NAV_ITEMS: readonly NavItem[]`, `navItemsFor(capabilities: string[]): NavItem[]`. Task 11 adds the capture route but not a nav item — capture is reached from the driver's task list, not the menu.

- [ ] **Step 1: Write the failing test**

Create `web/src/shell/navigation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { NAV_ITEMS, navItemsFor } from "./navigation";

describe("navItemsFor", () => {
  // A DRIVER holds exactly CaptureInspection (api/internal/auth/auth.go), and
  // the whole point of the shell is that their one destination is not buried
  // in a manager's menu.
  it("gives a driver exactly their own destinations", () => {
    const items = navItemsFor(["CaptureInspection"]);
    expect(items.map((i) => i.to)).toEqual(["/my"]);
  });

  it("gives a tenant-wide actor every destination they hold", () => {
    const admin = [
      "ViewFleet",
      "CaptureInspection",
      "ManageAssignments",
      "ManageAssets",
      "LogRetread",
      "ViewValuation",
      "ManageConfig",
      "ManageUsers",
    ];
    expect(navItemsFor(admin)).toEqual([...NAV_ITEMS]);
  });

  it("renders nothing for an actor with no capabilities", () => {
    expect(navItemsFor([])).toEqual([]);
  });

  // The server owns the capability vocabulary (web/src/auth/me.ts). A client
  // that crashed on a capability it had not heard of would break on deploy
  // ordering rather than degrade, so an unknown string is simply ignored.
  it("ignores a capability it has no destination for", () => {
    expect(navItemsFor(["SomethingAddedLater"])).toEqual([]);
  });

  // Menu order is a product decision, not an accident of Array.filter over
  // whatever order the server happened to serialise capabilities in.
  it("keeps registry order regardless of the order capabilities arrive in", () => {
    const forward = navItemsFor(["ViewFleet", "CaptureInspection"]);
    const reversed = navItemsFor(["CaptureInspection", "ViewFleet"]);
    expect(forward).toEqual(reversed);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/shell/navigation.test.ts`
Expected: FAIL — cannot resolve `./navigation`.

- [ ] **Step 3: Write the registry**

Create `web/src/shell/navigation.ts`:

```ts
// The one list. The menu renders it and the route guard reads the same
// capability strings, so a surface an actor cannot reach is never offered and
// the two cannot drift (NFR-SEC-006 — hiding is a courtesy, the server
// refuses regardless).
//
// Capabilities are strings, not a union: the server owns the vocabulary
// (web/src/auth/me.ts), and an unknown one degrades to a missing menu item
// rather than a crash on deploy ordering.
export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly capability: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/fleet", label: "Vehicles", capability: "ViewFleet" },
  { to: "/my", label: "My inspections", capability: "CaptureInspection" },
] as const;

export function navItemsFor(capabilities: string[]): NavItem[] {
  const held = new Set(capabilities);
  return NAV_ITEMS.filter((item) => held.has(item.capability));
}
```

> **Six of the eight capabilities have no surface yet.** `ManageAssignments`, `ManageAssets`, `LogRetread`, `ViewValuation`, `ManageConfig` and `ManageUsers` are held by an `ORG_ADMIN` and reach nothing today. Do **not** add dead entries for them — a menu item that 404s is worse than an absent one. The mechanism is what this ticket delivers: when sub-project 2 lands a valuation surface, it adds one line here and the menu grows on its own.

- [ ] **Step 4: Render the registry in the shell**

In `web/src/dashboard/AppShell.tsx`, replace the two hand-written `RequireCapability` links with the registry. `RequireCapability` stays in the file for other uses; the nav no longer needs it because `navItemsFor` has already filtered.

```tsx
function MainNav() {
  const actor = useActor();
  const items = navItemsFor(actor?.capabilities ?? []);
  if (items.length === 0) return null;
  return (
    <nav className="shell-nav" aria-label="Main">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

Import `navItemsFor` from `../shell/navigation` and drop the now-unused `RequireCapability` import if nothing else in the file uses it.

- [ ] **Step 5: Make the shell work on a phone**

In `web/src/dashboard/dashboard.css`. Three things, all of them functional requirements rather than polish:

```css
/* NFR-USE-004: gloves. 44px is the smallest target a gloved thumb hits
   reliably, and the nav is the one control a driver must not miss. */
.shell-nav a {
  min-height: 44px;
  display: flex;
  align-items: center;
  padding: 0 var(--space-3, 12px);
}

/* NFR-USE-003: direct sunlight. The focus ring has to survive a washed-out
   screen, so it is a solid offset outline rather than a tinted glow. */
.shell-nav a:focus-visible,
.shell-main :focus-visible {
  outline: 3px solid var(--primary);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* The driver's shell and the manager's shell are one product, not two: the
   header stacks and the nav becomes a row, but nothing is hidden behind a
   disclosure the sun makes invisible. */
@media (max-width: 640px) {
  .shell-header {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2, 8px);
  }
  .shell-nav {
    overflow-x: auto;
  }
}
```

If `--space-2` / `--space-3` are not in `tokens.ts`, add a `space` scale there and export it through `cssVars` rather than typing pixel values here — spacing is a token like any other.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `make web-test && make lint`
Expected: PASS, including the existing `routes.test.tsx` and `RequireCapability.test.tsx`.

- [ ] **Step 7: Commit**

```bash
git add web/src/shell web/src/dashboard/AppShell.tsx web/src/dashboard/dashboard.css
git commit -m "feat(web): TYRE-68 render navigation from the actor's capabilities"
```

---

### Task 2: The capture reference context, held in memory only (TYRE-69)

FR-OFF-001 gives the driver no connectivity after reference data loads, so everything a capture needs arrives in one round trip. FR-OFF-002 is equally clear about where it may live: **in memory for the session only, not persisted at rest on the device**. That is not a performance note — NFR-PRV-006 requires us to tell a driver on a personal phone that the only thing at rest is their in-progress inspection, and that statement has to be true.

**Files:**
- Create: `web/src/capture/captureContext.ts`
- Create: `web/src/capture/captureContext.test.ts`

**Interfaces:**
- Consumes: `apiGet` from `web/src/api/client.ts`; the JSON shape produced by Task 4 of the server plan.
- Produces: `CapturePosition`, `CaptureConfig`, `CaptureContext`, `fetchCaptureContext(vehicleId: string): Promise<CaptureContext>`, and `useCaptureContext(vehicleId: string)`. Tasks 3, 4, 6, 8 and 10 all consume these types.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/captureContext.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCaptureContext } from "./captureContext";

const body = {
  vehicleId: "11111111-1111-1111-1111-111111111111",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  combination: null,
  positions: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      vehicleId: "11111111-1111-1111-1111-111111111111",
      code: "1",
      sequence: 1,
      axleClass: "STEER",
      axleType: "FIXED",
      axleNumber: 1,
      isSpare: false,
      unitLabel: "Horse",
      tyreId: "33333333-3333-3333-3333-333333333333",
      tyreCode: "BAC-04217",
      previousGoverningMm: 12.0,
      previousReadingAt: "2026-07-23T06:00:00Z",
      fitmentSincePrevious: false,
      targetKpa: 800,
      warnUnderPct: 10,
      criticalUnderPct: 20,
      warnOverPct: 10,
      criticalOverPct: 20,
    },
  ],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4.0,
  },
  cohortWearRateMmPerMonth: { "STEER:FIXED": 0.82 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("fetchCaptureContext", () => {
  it("reads the whole capture context in one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = await fetchCaptureContext(body.vehicleId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/capture/vehicles/${body.vehicleId}`);
    expect(ctx.positions).toHaveLength(1);
    expect(ctx.config.removalThresholdMm).toBe(4.0);
    expect(ctx.cohortWearRateMmPerMonth["STEER:FIXED"]).toBe(0.82);
  });

  // FR-OFF-002 as amended by E2 and NFR-PRV-006. The device holds the
  // in-progress inspection and nothing else; a cached register on a driver's
  // personal phone is a different product with a different privacy notice.
  it("writes no part of the reference data to device storage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) }),
    );

    await fetchCaptureContext(body.vehicleId);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  // A driver refused a vehicle and a vehicle that does not exist must look
  // identical (ADR-0011), so the client cannot helpfully distinguish them
  // either — it reports one thing.
  it("surfaces a refusal without guessing why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) }),
    );

    await expect(fetchCaptureContext(body.vehicleId)).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/captureContext.test.ts`
Expected: FAIL — cannot resolve `./captureContext`.

- [ ] **Step 3: Write the loader**

Create `web/src/capture/captureContext.ts`:

```ts
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { getDevTenantId } from "../api/devTenant";

// Wire shape of GET /api/capture/vehicles/{id} (api/internal/httpapi/capture.go).
// Every field here exists because FR-OFF-001 takes connectivity away after
// this call returns: a warning whose input is missing is a warning that
// silently never fires.
export interface CapturePosition {
  id: string;
  vehicleId: string;
  code: string;
  sequence: number;
  axleClass: string;
  axleType: string;
  // Null on a spare, which has no axle. The diagram groups running positions
  // by (vehicleId, axleNumber) and draws spares separately.
  axleNumber: number | null;
  isSpare: boolean;
  unitLabel: string | null;
  tyreId: string | null;
  tyreCode: string | null;
  // FR-INS-034: the increase and the fitment that would excuse it.
  previousGoverningMm: number | null;
  previousReadingAt: string | null;
  fitmentSincePrevious: boolean;
  // FR-INS-037 / FR-INS-031a. Null on a spare: FR-CFG-013 as amended gives
  // SPARE no target, and an unclassified spare pressure is deliberate.
  targetKpa: number | null;
  warnUnderPct: number | null;
  criticalUnderPct: number | null;
  warnOverPct: number | null;
  criticalOverPct: number | null;
}

export interface CaptureConfig {
  treadReadingCount: number;
  // FR-CFG-027, stamped onto every reading (FR-INS-021).
  treadGranularityMm: number;
  widthSpreadWarnMm: number;
  odometerMaxDailyKm: number;
  wearRateAlertMultiple: number;
  removalThresholdMm: number;
}

// FR-INS-062: the rig a CONTROLLER set, for the driver to confirm before
// starting. The driver never composes it — managing what is coupled to
// what is fleet configuration, and it is set before the truck leaves.
export interface CaptureMember {
  vehicleId: string;
  fleetNumber: string;
  sequence: number;
  descriptor: string | null;
}

export interface CaptureCombination {
  id: string;
  members: CaptureMember[];
}

export interface CaptureContext {
  vehicleId: string;
  fleetNumber: string;
  registration: string | null;
  // HORSE / TRAILER / RIGID / LIGHT. A trailer has no odometer field at all
  // (FR-INS-020) and distance is never apportioned to one (FR-INS-064).
  unitKind: string;
  lastOdometerKm: number | null;
  // FR-INS-033 divides by the gap since this date; the value alone has no
  // denominator.
  lastOdometerAt: string | null;
  positions: CapturePosition[];
  // Null unless this unit heads a current combination — a solo rigid, or a
  // trailer asked for its own context, simply has none.
  combination: CaptureCombination | null;
  config: CaptureConfig;
  // Keyed "AXLE_CLASS:AXLE_TYPE" — BR-ANL-006 cohorts by position class and
  // BR-ANL-009 forbids blending axle types. A missing key means no rate is
  // asserted for that cohort, which for a LIFTING axle is the correct answer
  // rather than a gap.
  cohortWearRateMmPerMonth: Record<string, number>;
}

export function fetchCaptureContext(vehicleId: string): Promise<CaptureContext> {
  return apiGet<CaptureContext>(`/api/capture/vehicles/${vehicleId}`);
}

// staleTime Infinity, gcTime for the tab's life: FR-OFF-002 caches this for
// the session, and FR-OFF-003 refreshes it on app-open and on demand — never
// on a timer that could fire mid-walk-around and change a threshold under the
// driver's feet. Tanstack Query holds it in memory; nothing here persists.
export function useCaptureContext(vehicleId: string) {
  return useQuery({
    queryKey: ["capture-context", getDevTenantId() ?? "default", vehicleId],
    queryFn: () => fetchCaptureContext(vehicleId),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
```

> **Do not add a persister.** Tanstack Query has an official `persistQueryClient` plugin and reaching for it here would put the register on the driver's phone, contradicting FR-OFF-002, CR-006 and ADR-0009 in one line. The durable store in Tasks 6 and 8 is for the inspection, not for reference data.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/captureContext.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add web/src/capture/captureContext.ts web/src/capture/captureContext.test.ts
git commit -m "feat(capture): TYRE-69 session-memory capture reference context"
```

---
### Task 3: Per-position warnings — tread, spread and pressure (TYRE-69)

The rules a driver meets at the moment of entry. All four are Musts inside `FR-INS-020..041`, which the design commits to closing, so a partial set is a silent scope cut rather than a smaller feature.

**Two comparison boundaries are load-bearing and the SRS states them loosely.** FR-INS-036 says "below the configured policy threshold" but BR-RPT-006 says "**at or below** the removal threshold", and `db/tests/004_tests.sql` counts Appendix J with `governing_tread_mm <= 4`. FR-INS-041 says "exceeds a configurable margin" but BR-ANL-007 says "a spread **at or above** the configured margin", and the suite counts with `width_spread_mm >= 4`. **Use `<=` and `>=`.** The business rules govern, and getting either strict would put the capture app one position out of step with the database on the fixture — which is exactly the three-way disagreement CLAUDE.md exists to make visible.

**Files:**
- Create: `web/src/capture/warnings.ts`
- Create: `web/src/capture/warnings.test.ts`

**Interfaces:**
- Consumes: `CapturePosition`, `CaptureConfig` from Task 2.
- Produces: `WarningCode`, `Warning`, `PositionEntry`, `governingTread`, `widthSpread`, `positionWarnings`, `severityFor`, `Severity`. Tasks 4, 8, 9 and 10 consume these; Task 4 adds the history rules to the same `Warning` shape.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/warnings.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { CaptureConfig, CapturePosition } from "./captureContext";
import { governingTread, positionWarnings, severityFor, widthSpread } from "./warnings";

const config: CaptureConfig = {
  treadReadingCount: 3,
  treadGranularityMm: 1.0,
  widthSpreadWarnMm: 4,
  odometerMaxDailyKm: 1600,
  wearRateAlertMultiple: 3,
  removalThresholdMm: 4.0,
};

const steer: CapturePosition = {
  id: "p1",
  vehicleId: "v1",
  code: "1",
  sequence: 1,
  axleClass: "STEER",
  axleType: "FIXED",
  axleNumber: 1,
  isSpare: false,
  unitLabel: "Horse",
  tyreId: "t1",
  tyreCode: "BAC-04217",
  previousGoverningMm: 12,
  previousReadingAt: "2026-07-23T06:00:00Z",
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
};

const spare: CapturePosition = {
  ...steer,
  id: "p27",
  code: "S",
  isSpare: true,
  axleClass: "SPARE",
  axleNumber: null,
  targetKpa: null,
  warnUnderPct: null,
  criticalUnderPct: null,
  warnOverPct: null,
  criticalOverPct: null,
};

const codes = (ws: { code: string }[]) => ws.map((w) => w.code).sort();

describe("governingTread", () => {
  // BR-INS-003, and the client never sends it — the trigger derives it. This
  // exists so the driver sees the same number the database will store.
  it("is the minimum of the width-wise readings", () => {
    expect(governingTread([7.4, 7.1, 6.9])).toBe(6.9);
  });

  it("is null until every reading is entered", () => {
    expect(governingTread([7.4, null, 6.9])).toBeNull();
  });
});

describe("widthSpread", () => {
  it("is max minus min (BR-ANL-007)", () => {
    expect(widthSpread([15, 11, 15])).toBe(4);
  });
});

describe("positionWarnings", () => {
  it("raises nothing on a healthy position", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 800 }, steer, config);
    expect(w).toEqual([]);
  });

  // FR-INS-036 with BR-RPT-006's boundary: at the threshold is already a
  // problem, not the last safe millimetre.
  it("warns at the removal threshold, not one below it", () => {
    const w = positionWarnings({ treads: [4, 5, 6], pressureKpa: 800 }, steer, config);
    expect(codes(w)).toContain("FR-INS-036");
  });

  it("does not warn just above the threshold", () => {
    const w = positionWarnings({ treads: [5, 5, 6], pressureKpa: 800 }, steer, config);
    expect(codes(w)).not.toContain("FR-INS-036");
  });

  // FR-INS-041 with BR-ANL-007's boundary, and it must ask for a photograph.
  it("warns at the configured spread and prompts for a photograph", () => {
    const w = positionWarnings({ treads: [15, 11, 15], pressureKpa: 800 }, steer, config);
    const spread = w.find((x) => x.code === "FR-INS-041");
    expect(spread).toBeDefined();
    expect(spread?.promptPhoto).toBe(true);
  });

  // FR-INS-037: outside the warn band at 10% of an 800kPa target is <720 or
  // >880. Every number here comes from the payload; none is a literal in src.
  it("warns on a pressure outside the correct band", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 700 }, steer, config);
    expect(codes(w)).toContain("FR-INS-037");
  });

  // FR-INS-031a supersedes FR-INS-037 rather than stacking with it: at 20%
  // under, both rules are true, and showing a gloved driver two rows about
  // one number costs seconds the three-minute budget does not have.
  it("escalates to a confirmation instead of stacking two pressure warnings", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 600 }, steer, config);
    expect(codes(w)).toContain("FR-INS-031a");
    expect(codes(w)).not.toContain("FR-INS-037");
    expect(w.find((x) => x.code === "FR-INS-031a")?.requiresConfirmation).toBe(true);
  });

  // FR-CFG-013 as amended: SPARE carries no target. An unclassified spare
  // pressure is deliberate (BR-RPT-001, NFR-PRO-003) — inventing a band for
  // it would create a spare-pressure exception the SRS does not have.
  it("never raises a pressure warning on a spare", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 200 }, spare, config);
    expect(codes(w)).toEqual([]);
  });

  // BR-RPT-006 is the carve-out: spares are excluded from exception reports
  // by default, but a spare at threshold is the one that matters — it is the
  // vehicle's only replacement.
  it("still raises the tread warning on a spare", () => {
    const w = positionWarnings({ treads: [3, 4, 4], pressureKpa: 200 }, spare, config);
    expect(codes(w)).toEqual(["FR-INS-036"]);
  });

  it("raises nothing until the position is complete", () => {
    const w = positionWarnings({ treads: [3, null, null], pressureKpa: null }, steer, config);
    expect(w).toEqual([]);
  });

  // FR-INS-040: the record needs the value that provoked the warning, not
  // just that one happened.
  it("carries the entered value that provoked it", () => {
    const w = positionWarnings({ treads: [4, 5, 6], pressureKpa: 800 }, steer, config);
    expect(w.find((x) => x.code === "FR-INS-036")?.enteredValue).toBe("4");
  });
});

describe("severityFor", () => {
  it("is unmeasured before the position is complete", () => {
    expect(severityFor([], false)).toBe("unmeasured");
  });

  it("is roadworthy when a complete position raised nothing", () => {
    expect(severityFor([], true)).toBe("roadworthy");
  });

  it("is below-removal whenever the tread rule fired", () => {
    const w = positionWarnings({ treads: [4, 5, 6], pressureKpa: 800 }, steer, config);
    expect(severityFor(w, true)).toBe("below-removal");
  });

  it("is caution for any other warning", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 700 }, steer, config);
    expect(severityFor(w, true)).toBe("caution");
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/warnings.test.ts`
Expected: FAIL — cannot resolve `./warnings`.

- [ ] **Step 3: Write the rules**

Create `web/src/capture/warnings.ts`:

```ts
import type { CaptureConfig, CapturePosition } from "./captureContext";

// The code IS the requirement id: it travels in the submit payload to
// app.inspection_warning (DR-021) and is what a controller reads months later
// when asking why a driver was stopped. A private enum here would need a
// mapping table nobody maintains.
export type WarningCode =
  | "FR-INS-031a"
  | "FR-INS-032"
  | "FR-INS-033"
  | "FR-INS-034"
  | "FR-INS-035"
  | "FR-INS-036"
  | "FR-INS-037"
  | "FR-INS-041";

export interface Warning {
  code: WarningCode;
  // Where the SRS says "warn and require confirmation" the driver must act;
  // where it says "warn immediately" an acknowledgement is enough. Both are
  // recorded under FR-INS-040 — this only decides which response is written.
  requiresConfirmation: boolean;
  // NFR-USE-005: what happened and what to do, in plain language. Never the
  // words legal, roadworthy or minimum (CR-010, OR-LEG-001).
  message: string;
  enteredValue: string | null;
  promptPhoto?: boolean;
}

export interface PositionEntry {
  treads: (number | null)[];
  pressureKpa: number | null;
}

export type Severity = "roadworthy" | "caution" | "below-removal" | "unmeasured";

const complete = (e: PositionEntry, count: number) =>
  e.treads.length === count && e.treads.every((t) => t !== null) && e.pressureKpa !== null;

// BR-INS-003. The client shows this; the database derives its own from the
// measurements and the payload never carries it (CR-011, DR-017).
export function governingTread(treads: (number | null)[]): number | null {
  if (treads.length === 0 || treads.some((t) => t === null)) return null;
  return Math.min(...(treads as number[]));
}

// BR-ANL-007, a property of this inspection rather than of the tyre.
export function widthSpread(treads: (number | null)[]): number | null {
  if (treads.length === 0 || treads.some((t) => t === null)) return null;
  const t = treads as number[];
  return Math.max(...t) - Math.min(...t);
}

export function positionWarnings(
  entry: PositionEntry,
  position: CapturePosition,
  config: CaptureConfig,
): Warning[] {
  // Warning on a half-entered position would fire on the first digit of a
  // number that is about to become fine, which trains drivers to dismiss
  // warnings without reading them.
  if (!complete(entry, config.treadReadingCount)) return [];

  const out: Warning[] = [];
  const governing = governingTread(entry.treads);
  const spread = widthSpread(entry.treads);

  // FR-INS-036 at BR-RPT-006's boundary (<=, matching db/tests/004_tests.sql).
  // The threshold is the tenant's configured policy and is never described as
  // a legal limit (CR-010).
  if (governing !== null && governing <= config.removalThresholdMm) {
    out.push({
      code: "FR-INS-036",
      requiresConfirmation: false,
      message: `At or below this fleet's ${config.removalThresholdMm}mm replacement point. Report it.`,
      enteredValue: String(governing),
    });
  }

  // FR-INS-041 at BR-ANL-007's boundary (>=). The photograph is part of the
  // requirement, not an extra: uneven wear across the width is diagnosed from
  // the tyre, not from three numbers.
  if (spread !== null && spread >= config.widthSpreadWarnMm) {
    out.push({
      code: "FR-INS-041",
      requiresConfirmation: false,
      message: `${spread}mm difference across this tyre. Take a photo of the tread.`,
      enteredValue: String(spread),
      promptPhoto: true,
    });
  }

  // FR-CFG-013 as amended gives SPARE no target, so there is nothing to
  // compare against and the reading stays deliberately unclassified.
  if (entry.pressureKpa !== null && position.targetKpa !== null) {
    const target = position.targetKpa;
    const pct = ((entry.pressureKpa - target) / target) * 100;
    const criticalUnder = position.criticalUnderPct ?? Infinity;
    const criticalOver = position.criticalOverPct ?? Infinity;
    const warnUnder = position.warnUnderPct ?? Infinity;
    const warnOver = position.warnOverPct ?? Infinity;

    // At most one pressure warning. FR-INS-031a's confirmation supersedes
    // FR-INS-037's band: both are true beyond the critical tolerance, and two
    // rows about one number costs seconds the three-minute budget has not got.
    // Strict on the under side, inclusive on the over side — not a style
    // choice: app.inflation_pressure_summary (000013) bands with
    // `pct < 100 - critical_under_pct`, so at exactly -20% the database says
    // WARN and an inclusive client here would say CONFIRM. Same drift the
    // FR-INS-036/041 boundaries are pinned against.
    if (pct < -criticalUnder || pct >= criticalOver) {
      out.push({
        code: "FR-INS-031a",
        requiresConfirmation: true,
        message: `${entry.pressureKpa} kPa against a ${target} kPa target. Check the gauge and confirm.`,
        enteredValue: String(entry.pressureKpa),
      });
    } else if (pct < -warnUnder || pct >= warnOver) {
      out.push({
        code: "FR-INS-037",
        requiresConfirmation: false,
        message: `${entry.pressureKpa} kPa against a ${target} kPa target.`,
        enteredValue: String(entry.pressureKpa),
      });
    }
  }

  return out;
}

// Colour is never the only encoding (NFR-USE-009) — this names the state and
// the component pairs it with a text badge. The names are the fixed band names
// in theme/tokens.ts; the millimetres that reach them are tenant configuration.
export function severityFor(warnings: Warning[], isComplete: boolean): Severity {
  if (!isComplete) return "unmeasured";
  if (warnings.some((w) => w.code === "FR-INS-036")) return "below-removal";
  return warnings.length > 0 ? "caution" : "roadworthy";
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/warnings.test.ts`
Expected: PASS, all sixteen.

- [ ] **Step 5: Commit**

```bash
git add web/src/capture/warnings.ts web/src/capture/warnings.test.ts web/src/capture/captureContext.ts
git commit -m "feat(capture): TYRE-69 tread, spread and pressure warnings at entry"
```

---

### Task 4: History and odometer warnings (TYRE-69)

The two rules that need the vehicle's past, and the two that guard the odometer. These are the ones FR-OFF-002 was amended for: without the reference data Task 2 fetches, FR-INS-034 and FR-INS-035 cannot evaluate offline at all.

**Files:**
- Create: `web/src/capture/history.ts`
- Create: `web/src/capture/history.test.ts`

**Interfaces:**
- Consumes: `CaptureContext`, `CapturePosition`, `CaptureConfig` from Task 2; `Warning`, `PositionEntry`, `governingTread` from Task 3.
- Produces: `historyWarnings(entry, position, ctx, now): Warning[]` and `odometerWarnings(odometerKm, ctx, now): Warning[]`, plus `odometerRejection(odometerKm, ctx): string | null`. Tasks 9 and 10 consume all three.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/history.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { historyWarnings, odometerRejection, odometerWarnings } from "./history";

const NOW = new Date("2026-08-25T06:00:00Z");

const position: CapturePosition = {
  id: "p1",
  vehicleId: "v1",
  code: "1",
  sequence: 1,
  axleClass: "STEER",
  axleType: "FIXED",
  axleNumber: 1,
  isSpare: false,
  unitLabel: "Horse",
  tyreId: "t1",
  tyreCode: "BAC-04217",
  // One month earlier, so implied rates divide by roughly 1.0 months.
  previousGoverningMm: 12,
  previousReadingAt: "2026-07-26T06:00:00Z",
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
};

const ctx: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z", // six days before NOW
  combination: null,
  positions: [position],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4.0,
  },
  cohortWearRateMmPerMonth: { "STEER:FIXED": 0.8 },
};

const codes = (ws: { code: string }[]) => ws.map((w) => w.code);

describe("historyWarnings", () => {
  it("says nothing about a normal month's wear", () => {
    expect(historyWarnings({ treads: [11, 11, 12], pressureKpa: 800 }, position, ctx, NOW)).toEqual(
      [],
    );
  });

  // FR-INS-034 / BR-INS-001: tread does not grow. An increase is a possible
  // unlogged replacement (FR-FIT-024), not a measurement to accept quietly.
  it("warns when tread has increased with no fitment to explain it", () => {
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).toContain("FR-INS-034");
    expect(w.find((x) => x.code === "FR-INS-034")?.requiresConfirmation).toBe(true);
  });

  // The unless-clause is the whole rule. A new tyre reads deeper and that is
  // not an anomaly — warning anyway would train drivers to confirm blindly.
  it("stays silent when a fitment since the last reading explains the increase", () => {
    const fitted = { ...position, fitmentSincePrevious: true };
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, fitted, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-034");
  });

  // FR-INS-035: 12mm -> 8mm in one month is 4mm/month against a 0.8 cohort
  // average and a multiple of 3, so the trigger is 2.4mm/month.
  it("warns when the implied wear rate exceeds the configured multiple", () => {
    const w = historyWarnings({ treads: [8, 8, 9], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).toContain("FR-INS-035");
    expect(w.find((x) => x.code === "FR-INS-035")?.requiresConfirmation).toBe(true);
  });

  it("does not warn just under the multiple", () => {
    // 12 -> 10 is 2mm/month, under the 2.4 trigger.
    const w = historyWarnings({ treads: [10, 10, 11], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // BR-ANL-009: a lifted axle is not touching the road, so no rate is
  // asserted for it at all. An absent cohort key is that answer, and
  // defaulting it to any number would invent the rule the rule forbids.
  it("asserts no wear rate where the cohort has none", () => {
    const lifting = { ...position, axleType: "LIFTING" };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, lifting, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // BR-ANL-004: a fitment between the readings makes the pair meaningless for
  // a rate, the same reason it excuses the increase.
  it("computes no rate across a fitment", () => {
    const fitted = { ...position, fitmentSincePrevious: true };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, fitted, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  it("says nothing about a position with no history", () => {
    const fresh = { ...position, previousGoverningMm: null, previousReadingAt: null };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, fresh, ctx, NOW);
    expect(w).toEqual([]);
  });
});

describe("odometerRejection", () => {
  // FR-INS-032 says reject, not warn. BR-INS-002 is unconditional and the
  // server raises TY001 for it — refusing here saves the driver finding out
  // after the walk-around.
  it("refuses a reading below the last recorded one", () => {
    // toLocaleString("en-ZA") groups with a non-breaking space, and a
    // small-ICU build may group differently again — so match any single
    // non-digit rather than guessing which separator shipped.
    expect(odometerRejection(412000, ctx)).toMatch(/412\D?180/);
  });

  it("accepts a reading at or above it", () => {
    expect(odometerRejection(412180, ctx)).toBeNull();
    expect(odometerRejection(500000, ctx)).toBeNull();
  });

  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  it("accepts an absent odometer", () => {
    expect(odometerRejection(null, ctx)).toBeNull();
  });
});

describe("odometerWarnings", () => {
  // FR-INS-033: six days at a 1600km/day ceiling is 9600km of headroom.
  it("accepts a plausible distance", () => {
    expect(odometerWarnings(420000, ctx, NOW)).toEqual([]);
  });

  // The transposed digit the requirement exists for.
  it("warns and requires confirmation on an implausible daily distance", () => {
    const w = odometerWarnings(512180, ctx, NOW);
    expect(codes(w)).toEqual(["FR-INS-033"]);
    expect(w[0].requiresConfirmation).toBe(true);
    expect(w[0].enteredValue).toBe("512180");
  });

  it("says nothing when there is no previous reading to divide by", () => {
    const fresh = { ...ctx, lastOdometerKm: null, lastOdometerAt: null };
    expect(odometerWarnings(999999, fresh, NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/history.test.ts`
Expected: FAIL — cannot resolve `./history`.

- [ ] **Step 3: Write the rules**

Create `web/src/capture/history.ts`:

```ts
import type { CaptureContext, CapturePosition } from "./captureContext";
import type { PositionEntry, Warning } from "./warnings";
import { governingTread } from "./warnings";

// The same figure app.wear_rate_mm_per_month uses to convert days to months.
// It is a unit conversion, not a threshold, which is why it is a constant here
// and not tenant configuration — but it must match the database exactly or the
// client and the server disagree about what a month is.
const DAYS_PER_MONTH = 30.44;

const daysBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000;

export function historyWarnings(
  entry: PositionEntry,
  position: CapturePosition,
  ctx: CaptureContext,
  now: Date,
): Warning[] {
  const governing = governingTread(entry.treads);
  if (governing === null) return [];
  if (position.previousGoverningMm === null || position.previousReadingAt === null) return [];

  const out: Warning[] = [];
  const previous = position.previousGoverningMm;

  // FR-INS-034 / BR-INS-001. The unless-clause is the rule: a fitment since
  // the last reading is exactly what a deeper tyre means, and warning through
  // it teaches drivers to confirm without reading.
  if (governing > previous && !position.fitmentSincePrevious) {
    out.push({
      code: "FR-INS-034",
      requiresConfirmation: true,
      message: `Deeper than last time (${previous}mm). Was this tyre changed?`,
      enteredValue: String(governing),
    });
  }

  // FR-INS-035. BR-ANL-004 refuses a rate across a fitment and BR-ANL-009
  // asserts none at all for a lifting axle — an absent cohort key is that
  // answer, and defaulting it would manufacture the comparison the rule bans.
  const cohort = ctx.cohortWearRateMmPerMonth[`${position.axleClass}:${position.axleType}`];
  const months = daysBetween(new Date(position.previousReadingAt), now) / DAYS_PER_MONTH;
  if (cohort !== undefined && cohort > 0 && months > 0 && !position.fitmentSincePrevious) {
    const implied = (previous - governing) / months;
    const trigger = cohort * ctx.config.wearRateAlertMultiple;
    if (implied > trigger) {
      out.push({
        code: "FR-INS-035",
        requiresConfirmation: true,
        message: `Wearing far faster than this fleet's ${position.axleClass.toLowerCase()} tyres. Check the reading.`,
        enteredValue: String(governing),
      });
    }
  }

  return out;
}

// FR-INS-032 is a rejection, not a warning: BR-INS-002 is unconditional and
// the timeline raises TY001 for it on submit. Refusing at entry means the
// driver finds out while standing at the cab, not after the walk-around.
export function odometerRejection(odometerKm: number | null, ctx: CaptureContext): string | null {
  if (odometerKm === null || ctx.lastOdometerKm === null) return null;
  if (odometerKm >= ctx.lastOdometerKm) return null;
  return `Lower than the last recorded ${ctx.lastOdometerKm.toLocaleString("en-ZA")} km.`;
}

// FR-INS-033. The confirmation governs the capture flow only: DR-020 governs
// the timeline, so a confirmed implausible value still submits with the
// inspection and is preserved on the warning record rather than written to the
// odometer — the timeline is append-only (DR-018) and would keep it forever.
export function odometerWarnings(
  odometerKm: number | null,
  ctx: CaptureContext,
  now: Date,
): Warning[] {
  if (odometerKm === null || ctx.lastOdometerKm === null || ctx.lastOdometerAt === null) return [];
  const days = daysBetween(new Date(ctx.lastOdometerAt), now);
  if (days <= 0) return [];

  const perDay = (odometerKm - ctx.lastOdometerKm) / days;
  if (perDay <= ctx.config.odometerMaxDailyKm) return [];

  return [
    {
      code: "FR-INS-033",
      requiresConfirmation: true,
      message: `That is about ${Math.round(perDay).toLocaleString("en-ZA")} km a day since the last reading. Check the digits.`,
      enteredValue: String(odometerKm),
    },
  ];
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/history.test.ts`
Expected: PASS, all thirteen.

- [ ] **Step 5: Commit**

```bash
git add web/src/capture/history.ts web/src/capture/history.test.ts web/src/capture/captureContext.ts
git commit -m "feat(capture): TYRE-69 history and odometer warnings at entry"
```

---
### Task 5: The entry reducer — digits, settling and auto-advance (TYRE-69)

108 numeric entries in seven minutes is roughly four seconds per number including walking. The mechanic that makes it possible is that a field advances by itself the moment another digit could not change the answer, so most readings cost exactly the digits they contain and no confirming tap. The prototype's `key()` function is the reference; this generalises it to FR-CFG-027's three granularities and moves it somewhere a test can reach.

**Files:**
- Create: `web/src/capture/entry.ts`
- Create: `web/src/capture/entry.test.ts`

**Interfaces:**
- Consumes: nothing but its own types — deliberately pure, so the rule can be tested without a DOM.
- Produces: `EntryState`, `EntryKey`, `newEntryState(count)`, `applyKey(state, key, opts): EntryResult`, where `EntryResult` is `{ state: EntryState; settled: boolean }`. Task 9's `PositionSheet` owns the timer that acts on `settled`.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/entry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { applyKey, newEntryState } from "./entry";
import type { EntryState } from "./entry";

const whole = { treadReadingCount: 3, granularityMm: 1.0 };
const tenths = { treadReadingCount: 3, granularityMm: 0.1 };
const halves = { treadReadingCount: 3, granularityMm: 0.5 };

function type(start: EntryState, digits: string, opts: typeof whole) {
  return digits.split("").reduce(
    (acc, d) => {
      const r = applyKey(acc.state, { type: "digit", digit: d }, opts);
      return { state: r.state, settled: r.settled };
    },
    { state: start, settled: false },
  );
}

describe("applyKey at whole-millimetre granularity", () => {
  it("accumulates digits into the focused field", () => {
    const { state } = type(newEntryState(3), "13", whole);
    expect(state.treads[0]).toBe(13);
  });

  // The rule is one sentence: settle when appending any further digit would
  // exceed the ceiling. At 1.0mm that means 4..9 settle on the first press
  // (40 and up are past the 35mm limit) while 1, 2 and 3 wait, because
  // 10-35mm are real readings.
  it("settles a first digit that cannot grow", () => {
    const r = applyKey(newEntryState(3), { type: "digit", digit: "7" }, whole);
    expect(r.state.treads[0]).toBe(7);
    expect(r.settled).toBe(true);
  });

  it("waits on a first digit that can still grow", () => {
    const r = applyKey(newEntryState(3), { type: "digit", digit: "1" }, whole);
    expect(r.state.treads[0]).toBe(1);
    expect(r.settled).toBe(false);
  });

  it("settles once a second digit lands", () => {
    const { settled, state } = type(newEntryState(3), "13", whole);
    expect(state.treads[0]).toBe(13);
    expect(settled).toBe(true);
  });

  // FR-INS-030: 0-35mm is a rejection, not a warning. Rather than showing an
  // error for a value that cannot exist, the keypad restarts on the digit the
  // driver just pressed — which is almost always what they meant.
  it("restarts rather than accepting a value past the ceiling", () => {
    const { state } = type(newEntryState(3), "39", whole);
    expect(state.treads[0]).toBe(9);
  });

  it("moves to the next field on next, and to pressure after the last tread", () => {
    let s = newEntryState(3);
    s = applyKey(s, { type: "next" }, whole).state;
    expect(s.field).toBe(1);
    s = applyKey(applyKey(s, { type: "next" }, whole).state, { type: "next" }, whole).state;
    expect(s.field).toBe(3); // count === 3, so field 3 is pressure
  });

  it("clears the focused field on delete and stays put", () => {
    const { state } = type(newEntryState(3), "13", whole);
    const r = applyKey(state, { type: "delete" }, whole);
    expect(r.state.treads[0]).toBeNull();
    expect(r.state.field).toBe(0);
  });

  // Any-order completion: tapping a field goes straight to it, which is how a
  // driver corrects one number without re-entering the other two.
  it("focuses a field directly", () => {
    const r = applyKey(newEntryState(3), { type: "focus", field: 2 }, whole);
    expect(r.state.field).toBe(2);
  });
});

describe("applyKey on the pressure field", () => {
  const atPressure = () => ({ ...newEntryState(3), field: 3 });

  it("accepts three digits and settles when a fourth would exceed 1200 kPa", () => {
    const { state, settled } = type(atPressure(), "800", whole);
    expect(state.pressureKpa).toBe(800);
    expect(settled).toBe(true);
  });

  // FR-INS-031's ceiling is 1200, so a leading 1 keeps room for a fourth
  // digit and must not settle early — 1000 kPa is a real reading.
  it("waits for a fourth digit where one is still possible", () => {
    const { state, settled } = type(atPressure(), "120", whole);
    expect(state.pressureKpa).toBe(120);
    expect(settled).toBe(false);
  });

  it("accepts the four-digit value", () => {
    const { state } = type(atPressure(), "1000", whole);
    expect(state.pressureKpa).toBe(1000);
  });
});

describe("applyKey at other granularities (FR-CFG-027)", () => {
  // At 0.1mm the last digit is the tenth: 134 reads 13.4. The ceiling rule is
  // unchanged — it is the value, not the digit count, that decides.
  it("reads the final digit as tenths", () => {
    const { state } = type(newEntryState(3), "134", tenths);
    expect(state.treads[0]).toBeCloseTo(13.4);
  });

  it("settles when a further tenth digit would pass the ceiling", () => {
    const { settled, state } = type(newEntryState(3), "45", tenths);
    expect(state.treads[0]).toBeCloseTo(4.5);
    expect(settled).toBe(true);
  });

  // At 0.5mm the driver types whole millimetres and one extra key adds the
  // half — no decimal point on a keypad used with gloves.
  it("adds a half and settles", () => {
    const { state } = type(newEntryState(3), "13", halves);
    const r = applyKey(state, { type: "half" }, halves);
    expect(r.state.treads[0]).toBeCloseTo(13.5);
    expect(r.settled).toBe(true);
  });

  it("ignores the half key where the granularity has no halves", () => {
    const { state } = type(newEntryState(3), "13", whole);
    const r = applyKey(state, { type: "half" }, whole);
    expect(r.state.treads[0]).toBe(13);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/entry.test.ts`
Expected: FAIL — cannot resolve `./entry`.

- [ ] **Step 3: Write the reducer**

Create `web/src/capture/entry.ts`:

```ts
// FR-INS-030 / FR-INS-031: hard ranges, rejected rather than warned. They are
// physical limits of the instrument, not tenant policy, which is why they are
// constants here and not configuration (rule 5 governs thresholds, and these
// are not thresholds — the database CHECKs carry the same two numbers).
const TREAD_CEILING_MM = 35;
const PRESSURE_CEILING_KPA = 1200;

export interface EntryOptions {
  treadReadingCount: number;
  granularityMm: number;
}

export interface EntryState {
  treads: (number | null)[];
  pressureKpa: number | null;
  // 0..count-1 are the tread fields, count is pressure. One index rather than
  // a tagged union because the keypad advances through them in a line.
  field: number;
  // Digits pressed for the focused field. Kept apart from the value so a
  // leading zero and a correction are both representable.
  buffer: string;
}

export type EntryKey =
  | { type: "digit"; digit: string }
  | { type: "half" }
  | { type: "delete" }
  | { type: "next" }
  | { type: "focus"; field: number };

export interface EntryResult {
  state: EntryState;
  // True when no further digit could change this field's value, so the caller
  // may advance without waiting for a tap. The caller owns the timing; a
  // reducer that scheduled its own would not be testable.
  settled: boolean;
}

export function newEntryState(treadReadingCount: number): EntryState {
  return {
    treads: Array<number | null>(treadReadingCount).fill(null),
    pressureKpa: null,
    field: 0,
    buffer: "",
  };
}

const isPressure = (state: EntryState, opts: EntryOptions) => state.field >= opts.treadReadingCount;

// At 0.1mm the last digit typed is the tenth, so the buffer is read as an
// integer number of tenths. At 1.0 and 0.5 the buffer is whole millimetres and
// the half arrives on its own key — there is no decimal point on this keypad.
function valueOf(buffer: string, state: EntryState, opts: EntryOptions): number {
  const n = parseInt(buffer, 10);
  if (isPressure(state, opts)) return n;
  return opts.granularityMm === 0.1 ? n / 10 : n;
}

const ceilingFor = (state: EntryState, opts: EntryOptions) =>
  isPressure(state, opts) ? PRESSURE_CEILING_KPA : TREAD_CEILING_MM;

function write(state: EntryState, buffer: string, opts: EntryOptions): EntryState {
  const value = buffer === "" ? null : valueOf(buffer, state, opts);
  if (isPressure(state, opts)) return { ...state, buffer, pressureKpa: value };
  const treads = [...state.treads];
  treads[state.field] = value;
  return { ...state, buffer, treads };
}

export function applyKey(state: EntryState, key: EntryKey, opts: EntryOptions): EntryResult {
  switch (key.type) {
    case "focus":
      return { state: { ...state, field: key.field, buffer: "" }, settled: false };

    case "next":
      return {
        state: {
          ...state,
          field: Math.min(state.field + 1, opts.treadReadingCount),
          buffer: "",
        },
        settled: false,
      };

    case "delete":
      return { state: write(state, "", opts), settled: false };

    case "half": {
      // Only meaningful at 0.5mm granularity, and only on a tread field.
      if (opts.granularityMm !== 0.5 || isPressure(state, opts)) {
        return { state, settled: false };
      }
      const current = state.treads[state.field];
      if (current === null) return { state, settled: false };
      const treads = [...state.treads];
      treads[state.field] = Math.floor(current) + 0.5;
      return { state: { ...state, treads, buffer: "" }, settled: true };
    }

    case "digit": {
      const ceiling = ceilingFor(state, opts);
      const grown = state.buffer + key.digit;
      // Past the ceiling, restart on the digit just pressed rather than
      // showing an error for a value that cannot exist — a mis-tap is far
      // more likely than an intention to enter 39mm.
      const buffer = valueOf(grown, state, opts) > ceiling ? key.digit : grown;
      const next = write(state, buffer, opts);
      // The whole auto-advance rule, in one line: could another digit still
      // change this answer? Appending "0" is the smallest possible growth, so
      // if even that overshoots, nothing can.
      const settled = valueOf(buffer + "0", state, opts) > ceiling;
      return { state: next, settled };
    }
  }
}
```

> **`0` costs one extra tap at whole-millimetre granularity.** The prototype settles immediately on a lone `0` because no valid reading has a leading zero. That is a second rule for one keystroke, and it is wrong at 0.1mm where `0` then `5` is a real 0.5mm reading — so this keeps the single ceiling rule and lets a bald tyre cost one tap on `Next`. If field trial says otherwise, add the special case for `granularityMm === 1.0` only, with a test.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/entry.test.ts`
Expected: PASS, all fifteen.

- [ ] **Step 5: Commit**

```bash
git add web/src/capture/entry.ts web/src/capture/entry.test.ts
git commit -m "feat(capture): TYRE-69 keypad entry reducer with settle and auto-advance"
```

---

### Task 6: The durable draft — one in-progress inspection (TYRE-69)

FR-OFF-005 requires **every entry** to be written incrementally to a durable buffer, and FR-OFF-006 requires it to survive an application, browser or device restart. FR-OFF-007 was withdrawn in v1.4 precisely because this is one inspection whose lifetime is minutes, not a queue of fifty over days. NFR-USE-011 is the same requirement from the driver's side: they will get a phone call halfway through a superlink.

This is the first Dexie dependency in the repo, and the only thing in the product that writes to the driver's device.

**Files:**
- Create: `web/src/capture/draft.ts`
- Create: `web/src/capture/draft.test.ts`
- Modify: `web/package.json` (add `dexie`, `fake-indexeddb`)
- Modify: `web/src/test/setup.ts` (register the fake IndexedDB)

**Interfaces:**
- Consumes: `CaptureContext` from Task 2; `Warning` from Task 3.
- Produces: `RecordedWarning`, `DraftPosition`, `Draft`, `db` (the Dexie instance), `startDraft`, `loadDraft`, `savePosition`, `saveHeader`, `clearDraft`. Tasks 7, 9 and 10 consume them.

- [ ] **Step 1: Add the dependencies**

```bash
cd web && npm install dexie && npm install -D fake-indexeddb
```

Then in `web/src/test/setup.ts`, add the import that gives jsdom an IndexedDB:

```ts
// jsdom has no IndexedDB, so the durable-buffer tests would otherwise assert
// against a store that silently does not exist — which is the one failure mode
// FR-OFF-014 cannot tolerate going unnoticed.
import "fake-indexeddb/auto";
```

Check the built bundle against NFR-PRF-009's 500KB compressed budget once this lands: `cd web && npm run build` and read the gzip column. Dexie is roughly 25KB gzipped; if the budget is already tight, say so rather than quietly exceeding it.

- [ ] **Step 2: Write the failing test**

Create `web/src/capture/draft.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearDraft, db, loadDraft, saveHeader, savePosition, startDraft } from "./draft";

beforeEach(async () => {
  await db.open();
  await clearDraft();
});

afterEach(async () => {
  await clearDraft();
});

describe("the draft buffer", () => {
  it("generates the client uuid when the inspection starts, not when it is sent", async () => {
    const draft = await startDraft({ vehicleId: "v1", taskId: "t1", startedAt: "2026-08-25T06:00:00Z" });
    expect(draft.clientUuid).toMatch(/^[0-9a-f-]{36}$/);
    // FR-OFF-011 keys idempotency on this. Generated at send time it would
    // change on every retry and each retry would create a new inspection.
    const reloaded = await loadDraft();
    expect(reloaded?.clientUuid).toBe(draft.clientUuid);
  });

  // FR-OFF-005: incrementally, per entry — not on a debounce, not at the end.
  it("persists a position the moment it is entered", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await savePosition({
      positionId: "p1",
      vehicleId: "v1",
      tyreId: "ty1",
      treads: [13, 13, 14],
      pressureKpa: 800,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: 6,
      warnings: [],
    });

    const reloaded = await loadDraft();
    expect(reloaded?.positions["p1"].treads).toEqual([13, 13, 14]);
    expect(reloaded?.positions["p1"].seconds).toBe(6);
  });

  // FR-OFF-006 / NFR-USE-011. The store is the source of truth, not a mirror
  // of React state, so a reload finds the work rather than an empty form.
  it("survives a reload with every entry intact", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await savePosition({
      positionId: "p1",
      vehicleId: "v1",
      tyreId: null,
      treads: [9, 9, 10],
      pressureKpa: 750,
      pressureTemperature: "COLD",
      damageFlag: false,
      note: null,
      seconds: 5,
      warnings: [{ code: "FR-INS-037", response: "ACKNOWLEDGED", enteredValue: "750" }],
    });
    await db.close();
    await db.open();

    const reloaded = await loadDraft();
    expect(reloaded?.positions["p1"].pressureKpa).toBe(750);
    expect(reloaded?.positions["p1"].warnings[0].code).toBe("FR-INS-037");
  });

  it("keeps the header fields the review screen collects", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await saveHeader({ odometerKm: 412500, comment: "7/8 need replacing", defectReport: null });

    const reloaded = await loadDraft();
    expect(reloaded?.odometerKm).toBe(412500);
    expect(reloaded?.comment).toBe("7/8 need replacing");
  });

  // The buffer holds ONE inspection (FR-OFF-007 withdrawn v1.4). Starting a
  // second must not silently bury the first — FR-OFF-014 forbids discarding a
  // buffered inspection under any circumstance, so the caller has to deal with
  // it rather than the store deciding.
  it("refuses to start a second inspection over an unfinished one", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await expect(
      startDraft({ vehicleId: "v2", taskId: null, startedAt: "2026-08-25T07:00:00Z" }),
    ).rejects.toThrow(/in progress/i);
  });

  it("reports no draft once cleared", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await clearDraft();
    expect(await loadDraft()).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/draft.test.ts`
Expected: FAIL — cannot resolve `./draft`.

- [ ] **Step 4: Write the store**

Create `web/src/capture/draft.ts`:

```ts
import Dexie, { type EntityTable } from "dexie";

import type { WarningCode } from "./warnings";

// FR-INS-040 / DR-021: the code, the value that provoked it and what the
// driver did about it. The response is what the paper trail turns on months
// later, so it is captured here rather than reconstructed at submit.
export interface RecordedWarning {
  code: WarningCode;
  enteredValue: string | null;
  response: "ACKNOWLEDGED" | "CONFIRMED";
}

export interface DraftPosition {
  positionId: string;
  // The unit that OWNS the position, which on a rig is not the motive vehicle
  // (FR-INS-061). Rig-level numbering never appears here or on the wire.
  vehicleId: string;
  tyreId: string | null;
  // Entry order, left to right in the plan view (FR-INS-029a). The server maps
  // to OUTER/CENTRE/INNER by side on save; this array is never reordered.
  treads: (number | null)[];
  pressureKpa: number | null;
  pressureTemperature: "HOT" | "COLD" | "UNKNOWN";
  damageFlag: boolean;
  note: string | null;
  // NFR-OBS-007: median time-per-position, measured rather than assumed. It
  // cannot be retrofitted onto inspections already captured, which is why it
  // rides here from the first one.
  seconds: number;
  warnings: RecordedWarning[];
}

export interface Draft {
  clientUuid: string;
  vehicleId: string;
  combinationId: string | null;
  // FR-INS-062/063: what the driver confirmed was attached. The server records
  // a difference as an observation; it never creates a combination on submit.
  observedMemberVehicleIds: string[];
  taskId: string | null;
  startedAt: string;
  odometerKm: number | null;
  comment: string | null;
  defectReport: string | null;
  positions: Record<string, DraftPosition>;
  warnings: RecordedWarning[];
}

// The single row's fixed key. One in-progress inspection, whose lifetime is
// minutes or hours (FR-OFF-007 withdrawn in v1.4) — not a sync queue.
const DRAFT_KEY = "current";

interface DraftRow {
  key: string;
  draft: Draft;
}

const database = new Dexie("tyre-capture") as Dexie & {
  drafts: EntityTable<DraftRow, "key">;
};
database.version(1).stores({ drafts: "key", outbox: "clientUuid, state" });

export const db = database;

export async function loadDraft(): Promise<Draft | undefined> {
  return (await db.drafts.get(DRAFT_KEY))?.draft;
}

export async function startDraft(init: {
  vehicleId: string;
  taskId: string | null;
  startedAt: string;
  combinationId?: string | null;
  observedMemberVehicleIds?: string[];
}): Promise<Draft> {
  const existing = await loadDraft();
  if (existing) {
    // FR-OFF-014: never silently discard. The caller decides — finish it,
    // queue it, or explicitly abandon it — because only a person can.
    throw new Error("An inspection is already in progress on this device.");
  }
  const draft: Draft = {
    // Generated at start, not at send (design step 3): FR-OFF-011 keys
    // idempotency on it, so a value that changed per attempt would turn every
    // retry into a new inspection.
    clientUuid: crypto.randomUUID(),
    vehicleId: init.vehicleId,
    combinationId: init.combinationId ?? null,
    observedMemberVehicleIds: init.observedMemberVehicleIds ?? [],
    taskId: init.taskId,
    startedAt: init.startedAt,
    odometerKm: null,
    comment: null,
    defectReport: null,
    positions: {},
    warnings: [],
  };
  await db.drafts.put({ key: DRAFT_KEY, draft });
  return draft;
}

async function mutate(fn: (draft: Draft) => Draft): Promise<void> {
  await db.transaction("rw", db.drafts, async () => {
    const row = await db.drafts.get(DRAFT_KEY);
    if (!row) throw new Error("No inspection in progress.");
    await db.drafts.put({ key: DRAFT_KEY, draft: fn(row.draft) });
  });
}

export async function savePosition(position: DraftPosition): Promise<void> {
  await mutate((draft) => ({
    ...draft,
    positions: { ...draft.positions, [position.positionId]: position },
  }));
}

export async function saveHeader(patch: {
  odometerKm?: number | null;
  comment?: string | null;
  defectReport?: string | null;
  combinationId?: string | null;
  observedMemberVehicleIds?: string[];
  warnings?: RecordedWarning[];
}): Promise<void> {
  await mutate((draft) => ({ ...draft, ...patch }));
}

export async function clearDraft(): Promise<void> {
  await db.drafts.delete(DRAFT_KEY);
}
```

> **`clearDraft` is only ever called after the outbox has taken the inspection.** Task 7 moves it to the queue in one transaction and clears the draft in the same one. A `clearDraft` anywhere else in the codebase is an FR-OFF-014 violation — the requirement says *never*, *under any circumstance*.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/draft.test.ts`
Expected: PASS, all six.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/test/setup.ts web/src/capture/draft.ts web/src/capture/draft.test.ts
git commit -m "feat(capture): TYRE-69 durable draft buffer for the in-progress inspection"
```

---
### Task 7: The submit payload (TYRE-69)

One pure function turning a draft into the body `app.submit_inspection` reads. It is short and it is the highest-consequence function in the slice: entry order carries the anatomical meaning of every reading, and a reversal here would silently swap outer and inner on one whole side of every vehicle in the fleet, with no error anywhere and no way to tell from the stored data.

**The body is snake_case while `GET /api/capture/vehicles/{id}` is camelCase.** That is deliberate, not an oversight: the submit body is passed through to `app.submit_inspection(jsonb)` and read with SQL-style keys, whereas the GET response is shaped by Go struct tags. Do not "fix" either to match the other — the server plan's payload contract is the authority and Task 3 of that plan pins it.

**Files:**
- Create: `web/src/capture/payload.ts`
- Create: `web/src/capture/payload.test.ts`

**Interfaces:**
- Consumes: `Draft`, `DraftPosition` from Task 6; `CaptureConfig` from Task 2.
- Produces: `SubmitPayload` and `toSubmitPayload(draft, meta): SubmitPayload`, where `meta` is `{ submittedAt: string; granularityMm: number; deviceId: string; appVersion: string }`. Task 8 sends it.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/payload.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Draft } from "./draft";
import { toSubmitPayload } from "./payload";

const meta = {
  submittedAt: "2026-08-25T06:14:40Z",
  granularityMm: 1.0,
  deviceId: "device-1",
  appVersion: "0.0.0",
  totalPositions: 4,
};

const draft: Draft = {
  clientUuid: "0f8f0f8f-0f8f-0f8f-0f8f-0f8f0f8f0f8f",
  vehicleId: "v-horse",
  combinationId: "c1",
  observedMemberVehicleIds: ["v-horse", "v-link6"],
  taskId: "task-1",
  startedAt: "2026-08-25T06:12:00Z",
  odometerKm: 412500,
  comment: "7/8 need replacing",
  defectReport: null,
  positions: {
    p1: {
      positionId: "p1",
      vehicleId: "v-horse",
      tyreId: "ty1",
      treads: [13, 11, 14],
      pressureKpa: 800,
      pressureTemperature: "COLD",
      damageFlag: false,
      note: null,
      seconds: 6,
      warnings: [{ code: "FR-INS-041", enteredValue: "3", response: "ACKNOWLEDGED" }],
    },
    p2: {
      positionId: "p2",
      // A trailer position: owned by the towed unit, not the motive vehicle.
      vehicleId: "v-link6",
      tyreId: null,
      treads: [9, 9, 10],
      pressureKpa: 750,
      pressureTemperature: "UNKNOWN",
      damageFlag: true,
      note: "sidewall scuff",
      seconds: 5,
      warnings: [],
    },
  },
  warnings: [{ code: "FR-INS-033", enteredValue: "412500", response: "CONFIRMED" }],
};

describe("toSubmitPayload", () => {
  it("carries the header the server needs to place the inspection", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.client_uuid).toBe(draft.clientUuid);
    expect(p.vehicle_id).toBe("v-horse");
    expect(p.combination_id).toBe("c1");
    expect(p.task_id).toBe("task-1");
    expect(p.started_at).toBe("2026-08-25T06:12:00Z");
    expect(p.submitted_at).toBe(meta.submittedAt);
    expect(p.odometer_km).toBe(412500);
  });

  // THE assertion of this slice. FR-INS-029a maps entry order to
  // OUTER/CENTRE/INNER by side, on the server. Reorder, sort or reverse here
  // and every reading on one side of every vehicle is silently mislabelled.
  it("sends the treads in entry order, untouched", () => {
    const p = toSubmitPayload(draft, meta);
    const first = p.readings.find((r) => r.position_id === "p1");
    expect(first?.treads).toEqual([13, 11, 14]);
  });

  // CR-011 / DR-017 / TY006: the client sends measurements, the trigger
  // derives the minimum. Asserting it here would be rejected outright, and
  // rightly — two implementations of one rule is how they drift.
  it("never asserts a governing tread", () => {
    const p = toSubmitPayload(draft, meta);
    const raw = JSON.stringify(p);
    expect(raw).not.toContain("governing");
  });

  // BR-VEH-003 as amended by E2: rig numbers are a display projection,
  // computed at render time, never stored and never transmitted.
  it("transmits no rig-level position number", () => {
    const p = toSubmitPayload(draft, meta);
    for (const r of p.readings) {
      expect(r).not.toHaveProperty("sequence");
      expect(r).not.toHaveProperty("rig_position");
    }
  });

  // FR-INS-061: the owning unit, which for a trailer position is not the
  // inspection's motive vehicle.
  it("attributes each reading to the unit that owns the position", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.readings.find((r) => r.position_id === "p2")?.vehicle_id).toBe("v-link6");
  });

  // FR-INS-021: the granularity in force is stamped onto every reading.
  it("stamps the capture granularity on every reading", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.readings.every((r) => r.granularity_mm === 1.0)).toBe(true);
  });

  // NFR-OBS-007 and FR-INS-040: both ride in the payload or they do not exist.
  it("carries per-position seconds and every warning with its response", () => {
    const p = toSubmitPayload(draft, meta);
    const first = p.readings.find((r) => r.position_id === "p1");
    expect(first?.seconds).toBe(6);
    expect(first?.warnings[0]).toEqual({
      code: "FR-INS-041",
      entered_value: "3",
      response: "ACKNOWLEDGED",
    });
    expect(p.warnings[0].code).toBe("FR-INS-033");
  });

  it("computes the duration from the two timestamps", () => {
    expect(toSubmitPayload(draft, meta).duration_seconds).toBe(160);
  });

  // A partial inspection must say so. The column defaults to 100, so an
  // omitted value is not 'unknown' — it is a false claim of completeness.
  it("reports completeness against every position, not just the ones captured", () => {
    expect(toSubmitPayload(draft, meta).completeness_pct).toBe(50);
  });

  // FR-INS-062/063: what the driver said was attached. The server records a
  // difference from the recorded composition; it does not create one.
  it("carries the observed composition", () => {
    expect(toSubmitPayload(draft, meta).observed_member_vehicle_ids).toEqual([
      "v-horse",
      "v-link6",
    ]);
  });

  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  it("omits the odometer where there is none", () => {
    const trailerOnly = { ...draft, odometerKm: null };
    expect(toSubmitPayload(trailerOnly, meta).odometer_km).toBeNull();
  });

  // Positions are a keyed object in the draft so an entry overwrites cleanly;
  // the payload is an array, and its order must not depend on object key
  // iteration. NFR-USE-012 asks for natural order everywhere it is visible.
  // FR-OFF-005 persists per keystroke, so the draft legitimately holds
  // half-entered positions. They are not readings.
  it("omits a position that was started and not finished", () => {
    const partial: Draft = {
      ...draft,
      positions: {
        ...draft.positions,
        p3: {
          positionId: "p3",
          vehicleId: "v-horse",
          tyreId: null,
          treads: [12, null, null],
          pressureKpa: null,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 2,
          warnings: [],
        },
      },
    };
    const p = toSubmitPayload(partial, meta);
    expect(p.readings.map((r) => r.position_id)).toEqual(["p1", "p2"]);
    expect(p.completeness_pct).toBe(50);
  });

  it("orders readings by position id, deterministically", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.readings.map((r) => r.position_id)).toEqual(["p1", "p2"]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/payload.test.ts`
Expected: FAIL — cannot resolve `./payload`.

- [ ] **Step 3: Write the builder**

Create `web/src/capture/payload.ts`:

```ts
import type { Draft, RecordedWarning } from "./draft";

// Wire shape of POST /api/inspections. snake_case because the body reaches
// app.submit_inspection(jsonb) and is read with SQL-style keys — deliberately
// unlike the camelCase GET response, which Go struct tags shape.
export interface SubmitWarning {
  code: string;
  entered_value: string | null;
  response: string | null;
}

export interface SubmitReading {
  vehicle_id: string;
  position_id: string;
  tyre_id: string | null;
  pressure_kpa: number | null;
  pressure_temperature: string;
  damage_flag: boolean;
  note: string | null;
  treads: number[];
  granularity_mm: number;
  seconds: number;
  warnings: SubmitWarning[];
}

export interface SubmitPayload {
  client_uuid: string;
  vehicle_id: string;
  combination_id: string | null;
  observed_member_vehicle_ids: string[];
  task_id: string | null;
  started_at: string;
  submitted_at: string;
  odometer_km: number | null;
  duration_seconds: number;
  // app.inspection.completeness_pct defaults to 100, so a partial
  // inspection submitted without this is stored as complete — and
  // FR-INS-047's coverage figure then counts it as one (NFR-PRO-003
  // forbids exactly that kind of silent flattery).
  completeness_pct: number;
  comment: string | null;
  defect_report: string | null;
  device_id: string;
  app_version: string;
  readings: SubmitReading[];
  warnings: SubmitWarning[];
}

export interface SubmitMeta {
  submittedAt: string;
  granularityMm: number;
  deviceId: string;
  appVersion: string;
  // Every position across every member unit, from the capture contexts —
  // the denominator the draft itself does not know.
  totalPositions: number;
}

// NFR-OBS-004 records submit success rate per device, so the id has to be
// stable across sessions — which means localStorage, and which is NOT a
// breach of FR-OFF-002: that prohibits caching the fleet REFERENCE DATA on
// the device, not a random opaque string that identifies nobody. It carries
// no personal information (NFR-PRV-002) and survives a cleared browser only
// by being regenerated.
const DEVICE_KEY = "tyre.device-id";

export function deviceId(): string {
  try {
    const held = window.localStorage.getItem(DEVICE_KEY);
    if (held) return held;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Private mode: an unattributable submit beats a failed one.
    return "unknown";
  }
}

// Vite replaces this at build time. Add to vite.config.ts:
//   define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev") }
// and declare it in src/vite-env.d.ts as `declare const __APP_VERSION__: string;`
// so tsc sees it. Defined from package.json, so a deployed bundle traces to
// a release.
export const appVersion = __APP_VERSION__;

const wire = (w: RecordedWarning): SubmitWarning => ({
  code: w.code,
  entered_value: w.enteredValue,
  response: w.response,
});

export function toSubmitPayload(draft: Draft, meta: SubmitMeta): SubmitPayload {
  // FR-OFF-005 writes a position on the FIRST digit, so an abandoned
  // position sits in the draft half-entered. Sending it would fail the
  // tread-count check (TY005 -> 422), which the outbox classifies as
  // permanent — turning a driver's own mid-entry into "call the office".
  // An incomplete position is not captured, and completeness says so.
  const captured = Object.values(draft.positions).filter(
    (p) => p.pressureKpa !== null && p.treads.length > 0 && p.treads.every((t) => t !== null),
  );

  const readings: SubmitReading[] = captured
    // Object key order is an implementation detail of how the driver happened
    // to walk the vehicle; the payload should not vary with it.
    .sort((a, b) => a.positionId.localeCompare(b.positionId, undefined, { numeric: true }))
    .map((p) => ({
      // FR-INS-061 / BR-VEH-003: the unit that owns the position, and its own
      // position id. The 1..26 a driver sees on a rig is computed for the
      // diagram and never leaves the display layer.
      vehicle_id: p.vehicleId,
      position_id: p.positionId,
      // FR-INS-026/027 with FR-OFF-016: what the driver physically saw. The
      // server accepts it and records a discrepancy rather than refusing.
      tyre_id: p.tyreId,
      pressure_kpa: p.pressureKpa,
      pressure_temperature: p.pressureTemperature,
      damage_flag: p.damageFlag,
      note: p.note,
      // FR-INS-029a: entry order, left to right in the plan view. Never
      // sorted, never reversed — the server maps ordinal to
      // OUTER/CENTRE/INNER by the position's side. No governing value is sent
      // (CR-011, DR-017); the trigger derives it.
      treads: p.treads.filter((t): t is number => t !== null),
      granularity_mm: meta.granularityMm,
      seconds: p.seconds,
      warnings: p.warnings.map(wire),
    }));

  return {
    client_uuid: draft.clientUuid,
    vehicle_id: draft.vehicleId,
    combination_id: draft.combinationId,
    observed_member_vehicle_ids: draft.observedMemberVehicleIds,
    task_id: draft.taskId,
    started_at: draft.startedAt,
    submitted_at: meta.submittedAt,
    odometer_km: draft.odometerKm,
    duration_seconds: Math.round(
      (new Date(meta.submittedAt).getTime() - new Date(draft.startedAt).getTime()) / 1000,
    ),
    completeness_pct:
      meta.totalPositions === 0
        ? 0
        : Math.round((readings.length / meta.totalPositions) * 100),
    comment: draft.comment,
    defect_report: draft.defectReport,
    device_id: meta.deviceId,
    app_version: meta.appVersion,
    readings,
    warnings: draft.warnings.map(wire),
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/payload.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Commit**

```bash
git add web/src/capture/payload.ts web/src/capture/payload.test.ts
git commit -m "feat(capture): TYRE-69 submit payload preserving entry order"
```

---

### Task 8: The outbox — queue, backoff, and the refusal that must not be retried (TYRE-69)

The half the hypothesis rests on. A completed walk-around must never be lost, must be safe to replay, and must distinguish a network that will come back from a refusal that never will — because retrying a `409` for thirty minutes is a phone hammering an answer that cannot change while the driver waits for a resolution nobody is being asked for.

**Files:**
- Create: `web/src/capture/outbox.ts`
- Create: `web/src/capture/outbox.test.ts`
- Modify: `web/src/api/client.ts` (add `apiPost` and `ApiError`)

**Interfaces:**
- Consumes: `db`, `Draft`, `loadDraft`, `clearDraft` from Task 6; `toSubmitPayload` from Task 7.
- Produces: `ApiError` (from `client.ts`, carrying `status`), `OutboxEntry`, `OutboxState`, `queueDraft`, `listOutbox`, `attemptSend`, `flushOutbox`, `classify`, `backoffMs`, `isStale`. Task 10 renders the indicator and wires *Sync now*.

- [ ] **Step 1: Give `apiPost` a typed status**

In `web/src/api/client.ts`. The outbox's whole branch depends on the status code, so a thrown `Error` whose message happens to contain a number is not good enough.

```ts
// The status is the outbox's decision (FR-OFF-012 vs FR-OFF-013), so it is a
// field rather than something to parse back out of a message string.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const devTenant = getDevTenantId();
  const devActor = getDevActorId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;
  if (devActor) headers["X-User-ID"] = devActor;

  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new ApiError(res.status, `POST ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
```

Change `apiGet` to throw `ApiError` too, so one error type covers both and Task 2's `rejects.toThrow(/403/)` still passes.

- [ ] **Step 2: Write the failing test**

Create `web/src/capture/outbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import { clearDraft, db, savePosition, startDraft } from "./draft";
import {
  attemptSend,
  backoffMs,
  classify,
  isStale,
  listOutbox,
  queueDraft,
  startOutboxHeartbeat,
} from "./outbox";

const meta = { granularityMm: 1.0, deviceId: "device-1", appVersion: "0.0.0", totalPositions: 1 };

beforeEach(async () => {
  await db.open();
  await clearDraft();
  await db.table("outbox").clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function queueOne() {
  await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:12:00Z" });
  await savePosition({
    positionId: "p1",
    vehicleId: "v1",
    tyreId: null,
    treads: [13, 13, 14],
    pressureKpa: 800,
    pressureTemperature: "COLD",
    damageFlag: false,
    note: null,
    seconds: 6,
    warnings: [],
  });
  return queueDraft({ ...meta, submittedAt: "2026-08-25T06:14:40Z" });
}

describe("classify", () => {
  // FR-OFF-013: a permanent failure needs a person, and the driver must be
  // told now rather than after thirty minutes of silent retrying.
  it("treats the duplicate-window refusal as permanent", () => {
    expect(classify(new ApiError(409, "x"))).toBe("permanent");
  });

  it("treats an unprocessable payload as permanent", () => {
    expect(classify(new ApiError(422, "x"))).toBe("permanent");
  });

  it("treats a refused actor as permanent", () => {
    expect(classify(new ApiError(403, "x"))).toBe("permanent");
  });

  // A body the server could not parse will not become parseable by waiting.
  it("treats a malformed body as permanent", () => {
    expect(classify(new ApiError(400, "x"))).toBe("permanent");
  });

  // FR-OFF-012: everything else is the network or the server, and both come
  // back. Rate limiting especially (NFR-SEC-007) — a 429 is a "later", not a
  // "never".
  it("treats a server fault, a rate limit and a dead network as retryable", () => {
    expect(classify(new ApiError(500, "x"))).toBe("retryable");
    expect(classify(new ApiError(429, "x"))).toBe("retryable");
    expect(classify(new TypeError("Failed to fetch"))).toBe("retryable");
  });
});

describe("backoffMs", () => {
  it("grows exponentially", () => {
    expect(backoffMs(0)).toBeLessThan(backoffMs(1));
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
  });

  // FR-OFF-012's ceiling, exactly.
  it("never exceeds thirty minutes", () => {
    for (const attempt of [5, 10, 50, 1000]) {
      expect(backoffMs(attempt)).toBeLessThanOrEqual(30 * 60 * 1000);
    }
    expect(backoffMs(1000)).toBe(30 * 60 * 1000);
  });
});

describe("the outbox", () => {
  // FR-OFF-005: the draft moves to the queue, and the two never both hold it
  // or neither does. One transaction, or an inspection can vanish between
  // them — which FR-OFF-014 forbids outright.
  it("moves the draft to the queue atomically", async () => {
    await queueOne();
    expect(await listOutbox()).toHaveLength(1);
    expect(await db.drafts.get("current")).toBeUndefined();
  });

  it("releases the entry on a 201", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ inspectionId: "i1" }),
      }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    expect(await listOutbox()).toHaveLength(0);
  });

  // FR-OFF-011: the outbox replays anything it did not clearly hear an answer
  // to, so a 200 replay has to release the entry exactly as a 201 does.
  it("releases the entry on a replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ inspectionId: "i1" }),
      }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    expect(await listOutbox()).toHaveLength(0);
  });

  it("keeps the entry and schedules a retry on a server fault", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    const [queued] = await listOutbox();
    expect(queued.state).toBe("queued");
    expect(queued.attempts).toBe(1);
    expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  // FR-OFF-013: preserved locally, presented to the user, with a recovery
  // action — never retried into the void and never dropped.
  it("stops retrying a permanent refusal but keeps the inspection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    const [failed] = await listOutbox();
    expect(failed.state).toBe("failed");
    expect(failed.lastStatus).toBe(409);
    // FR-OFF-014, the load-bearing half: the readings are still here.
    expect(failed.payload.readings).toHaveLength(1);
  });

  it("does not send an entry before its backoff has elapsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);
    await attemptSend(entry.clientUuid);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FR-OFF-010: the driver can always force it, whatever the backoff says.
  // FR-OFF-012: the schedule needs a pulse, or a 500 taken while online is
  // never retried at all.
  it("retries on the heartbeat once the backoff has elapsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const stop = startOutboxHeartbeat(1000);
    await queueOne();

    await attemptSend((await listOutbox())[0].clientUuid);
    await vi.advanceTimersByTimeAsync(backoffMs(1) + 2000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    stop();
    vi.useRealTimers();
  });

  it("sends immediately when the driver asks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);
    await attemptSend(entry.clientUuid, { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("isStale", () => {
  // FR-OFF-020: roughly two days, because on iOS an unsynced buffer is
  // genuinely at risk of eviction by then.
  it("is quiet for a day and warns after two", () => {
    const now = Date.parse("2026-08-25T06:00:00Z");
    expect(isStale({ queuedAt: now - 24 * 3600_000 }, now)).toBe(false);
    expect(isStale({ queuedAt: now - 49 * 3600_000 }, now)).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/outbox.test.ts`
Expected: FAIL — cannot resolve `./outbox`.

- [ ] **Step 4: Write the outbox**

Create `web/src/capture/outbox.ts`:

```ts
import { ApiError, apiPost } from "../api/client";
import { db, loadDraft } from "./draft";
import type { SubmitMeta, SubmitPayload } from "./payload";
import { toSubmitPayload } from "./payload";

export type OutboxState = "queued" | "sending" | "failed";

export interface OutboxEntry {
  clientUuid: string;
  state: OutboxState;
  payload: SubmitPayload;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastStatus: number | null;
  lastError: string | null;
}

// FR-OFF-012's ceiling. Thirty minutes, not "about half an hour": the
// requirement gives the number and the test asserts it exactly.
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 1000;
// FR-OFF-020: approximately two days, when iOS eviction becomes a real risk.
const STALE_AFTER_MS = 48 * 3600 * 1000;

const table = () => db.table<OutboxEntry, string>("outbox");

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

// The distinction the whole outbox turns on. A permanent refusal will read the
// same in thirty minutes and in thirty hours, so retrying it burns the
// driver's battery and their airtime (NFR-CST-010) while hiding the fact that
// somebody has to act. 403 sits here too: an actor who may not capture will
// not acquire the capability by waiting.
export function classify(error: unknown): "permanent" | "retryable" {
  if (error instanceof ApiError) {
    if ([400, 403, 409, 422].includes(error.status)) return "permanent";
    return "retryable";
  }
  // A TypeError from fetch is a dead network, which is the case this whole
  // design exists for.
  return "retryable";
}

export function isStale(entry: { queuedAt: number }, now: number = Date.now()): boolean {
  return now - entry.queuedAt >= STALE_AFTER_MS;
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  return table().toArray();
}

// One transaction. Between removing the draft and inserting the queue entry
// there must be no moment where a crash loses the inspection (FR-OFF-014).
export async function queueDraft(meta: SubmitMeta): Promise<OutboxEntry> {
  return db.transaction("rw", db.drafts, table(), async () => {
    const draft = await loadDraft();
    if (!draft) throw new Error("No inspection in progress.");
    const entry: OutboxEntry = {
      clientUuid: draft.clientUuid,
      state: "queued",
      payload: toSubmitPayload(draft, meta),
      queuedAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      lastStatus: null,
      lastError: null,
    };
    await table().put(entry);
    await db.drafts.delete("current");
    return entry;
  });
}

export async function attemptSend(
  clientUuid: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const entry = await table().get(clientUuid);
  if (!entry) return;
  if (entry.state === "failed" && !opts.force) return;
  if (!opts.force && Date.now() < entry.nextAttemptAt) return;

  await table().update(clientUuid, { state: "sending" });
  try {
    // FR-OFF-011: 201 first time, 200 on replay, and the outbox treats them
    // identically — the server has the inspection either way, which is the
    // only question the queue is asking.
    await apiPost<{ inspectionId: string }>("/api/inspections", entry.payload);
    await table().delete(clientUuid);
  } catch (error) {
    const attempts = entry.attempts + 1;
    const permanent = classify(error) === "permanent";
    await table().update(clientUuid, {
      state: permanent ? "failed" : "queued",
      attempts,
      nextAttemptAt: permanent ? 0 : Date.now() + backoffMs(attempts),
      lastStatus: error instanceof ApiError ? error.status : null,
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

// FR-OFF-009: on app-open and whenever connectivity returns while the app is
// open. Never Background Sync — iOS Safari does not have it and ADR-0009
// settled that this design does not depend on it.
export async function flushOutbox(opts: { force?: boolean } = {}): Promise<void> {
  for (const entry of await listOutbox()) {
    await attemptSend(entry.clientUuid, opts);
  }
}

// FR-OFF-012 says retry with backoff "while the app is open", and nextAttemptAt
// is only ever consulted by attemptSend — so without a heartbeat an entry that
// failed with a 500 while online would wait for a reload or a connectivity
// flap that may never come. The interval is the pulse, the backoff is the
// schedule; the two together are the requirement.
export function startOutboxHeartbeat(everyMs = 30_000): () => void {
  const handle = window.setInterval(() => void flushOutbox(), everyMs);
  return () => window.clearInterval(handle);
}
```

Nothing here ever deletes an entry except on success. That is FR-OFF-014 and it is worth re-reading the file for before committing.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/outbox.test.ts`
Expected: PASS, all fifteen.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/client.ts web/src/capture/outbox.ts web/src/capture/outbox.test.ts
git commit -m "feat(capture): TYRE-69 durable submit outbox with permanent-refusal handling"
```

---
### Task 9: The rig projection and the axle diagram (TYRE-69)

A driver walks a rig; the data model holds independent units. FR-INS-060 requires one continuous sequence across member units, FR-INS-061 requires every reading recorded against the unit that owns the position, and FR-VEH-034 requires the continuous number to be **computed at render time** and never stored. This task is where those three meet: a pure projection with a test, and a diagram that renders it.

Each member unit is a separate `GET /api/capture/vehicles/{id}`. Three calls for a superlink, all made at start while the driver still has signal (FR-OFF-001), never one per position.

**Files:**
- Create: `web/src/capture/rig.ts`
- Create: `web/src/capture/rig.test.ts`
- Create: `web/src/capture/CaptureDiagram.tsx`
- Create: `web/src/capture/capture.css`

**Interfaces:**
- Consumes: `CaptureContext`, `CapturePosition` from Task 2; `Severity` from Task 3.
- Produces: `RigPosition`, `rigPositions(contexts)`, `completenessByUnit(contexts, done)`, and `<CaptureDiagram positions severityFor onOpen />`. Tasks 10 and 11 consume them.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/rig.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { completenessByUnit, rigPositions } from "./rig";

const position = (over: Partial<CapturePosition> & { id: string; sequence: number }): CapturePosition => ({
  vehicleId: "v",
  code: String(over.sequence),
  axleClass: "DRIVE",
  axleType: "FIXED",
  axleNumber: 1,
  isSpare: false,
  unitLabel: null,
  tyreId: null,
  tyreCode: null,
  previousGoverningMm: null,
  previousReadingAt: null,
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
  ...over,
});

const unit = (vehicleId: string, fleetNumber: string, positions: CapturePosition[]): CaptureContext => ({
  vehicleId,
  fleetNumber,
  registration: null,
  unitKind: "HORSE",
  lastOdometerKm: null,
  lastOdometerAt: null,
  combination: null,
  positions: positions.map((p) => ({ ...p, vehicleId })),
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
  },
  cohortWearRateMmPerMonth: {},
});

const horse = unit("v-horse", "BAC039SP", [
  position({ id: "h1", sequence: 1, axleClass: "STEER" }),
  position({ id: "h2", sequence: 2, axleClass: "STEER" }),
  position({ id: "hs", sequence: 99, isSpare: true, axleClass: "SPARE" }),
]);

const link = unit("v-link", "BAC040SP", [
  position({ id: "l1", sequence: 1, axleClass: "TRAILER" }),
  position({ id: "l2", sequence: 2, axleClass: "TRAILER" }),
]);

describe("rigPositions", () => {
  // FR-VEH-034 / BR-VEH-001: 1..n across member units, computed from member
  // order and each unit's own sequence. Never stored, never transmitted — the
  // payload names (vehicle_id, position_id) and this number is display only.
  it("numbers running positions continuously across member units", () => {
    const rig = rigPositions([horse, link]);
    const running = rig.filter((r) => !r.position.isSpare);
    expect(running.map((r) => r.displayNumber)).toEqual([1, 2, 3, 4]);
    expect(running.map((r) => r.position.id)).toEqual(["h1", "h2", "l1", "l2"]);
  });

  // Composition order is the whole projection: the same units in a different
  // order are a different rig and a different set of numbers.
  it("renumbers when the composition order changes", () => {
    const rig = rigPositions([link, horse]);
    const running = rig.filter((r) => !r.position.isSpare);
    expect(running.map((r) => r.position.id)).toEqual(["l1", "l2", "h1", "h2"]);
  });

  // Spares carry no running number: they are not in the walk-around sequence
  // and BR-RPT-001/BR-RPT-007 treat them as a separate population entirely.
  it("gives a spare no running number", () => {
    const spare = rigPositions([horse, link]).find((r) => r.position.isSpare);
    expect(spare?.displayNumber).toBeNull();
  });

  it("keeps each position bound to the unit that owns it", () => {
    const rig = rigPositions([horse, link]);
    expect(rig.find((r) => r.position.id === "l1")?.context.fleetNumber).toBe("BAC040SP");
    expect(rig.find((r) => r.position.id === "l1")?.position.vehicleId).toBe("v-link");
  });

  it("handles a solo unit without inventing a rig", () => {
    const solo = rigPositions([horse]);
    expect(solo.filter((r) => !r.position.isSpare).map((r) => r.displayNumber)).toEqual([1, 2]);
  });
});

describe("completenessByUnit", () => {
  // FR-INS-065: per member unit as well as for the rig. A driver who has
  // finished the horse and not the trailer needs to be told which, not a
  // single "18 of 26 done" that hides where the gap is.
  it("reports progress for each member unit", () => {
    const done = new Set(["h1", "hs", "l1"]);
    expect(completenessByUnit([horse, link], done)).toEqual([
      { vehicleId: "v-horse", fleetNumber: "BAC039SP", done: 2, total: 3 },
      { vehicleId: "v-link", fleetNumber: "BAC040SP", done: 1, total: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/rig.test.ts`
Expected: FAIL — cannot resolve `./rig`.

- [ ] **Step 3: Write the projection**

Create `web/src/capture/rig.ts`:

```ts
import type { CaptureContext, CapturePosition } from "./captureContext";

export interface RigPosition {
  position: CapturePosition;
  // The unit that owns it, kept alongside so the sheet can show the fleet
  // number and read that unit's own configuration.
  context: CaptureContext;
  // FR-VEH-034: computed here, rendered, and discarded. It is never stored and
  // never transmitted (BR-VEH-003 as amended by E2) — the payload names
  // vehicle_id and position_id. Null for a spare, which is not in the
  // walk-around sequence at all.
  displayNumber: number | null;
}

export function rigPositions(contexts: CaptureContext[]): RigPosition[] {
  let running = 0;
  return contexts.flatMap((context) =>
    [...context.positions]
      // BR-VEH-001 numbers positions within a unit from 1, foremost axle
      // first, then left to right — which is exactly what position.sequence
      // already encodes. Sorting by it here means the projection depends on
      // the configuration, not on the order the API happened to return.
      .sort((a, b) => a.sequence - b.sequence)
      .map((position) => ({
        position,
        context,
        displayNumber: position.isSpare ? null : ++running,
      })),
  );
}

export interface UnitCompleteness {
  vehicleId: string;
  fleetNumber: string;
  done: number;
  total: number;
}

// FR-INS-065: completeness per member unit as well as for the rig. The rig
// total is the sum, so it is not computed separately and cannot disagree.
export function completenessByUnit(
  contexts: CaptureContext[],
  donePositionIds: ReadonlySet<string>,
): UnitCompleteness[] {
  return contexts.map((context) => ({
    vehicleId: context.vehicleId,
    fleetNumber: context.fleetNumber,
    done: context.positions.filter((p) => donePositionIds.has(p.id)).length,
    total: context.positions.length,
  }));
}
```

- [ ] **Step 4: Write the diagram**

Create `web/src/capture/CaptureDiagram.tsx`. The prototype's `renderDiagram`/`cell` pair is the reference for the layout; this is its React form.

```tsx
import type { Severity } from "./warnings";
import type { RigPosition } from "./rig";

interface Props {
  positions: RigPosition[];
  severityOf: (positionId: string) => Severity;
  governingOf: (positionId: string) => number | null;
  onOpen: (positionId: string) => void;
  activeId: string | null;
}

// Plan view, nose up — the same frame BR-VEH-001 numbers positions in and the
// frame FR-INS-029a means by "left-to-right". Every entry screen in the app
// shows the vehicle this way round so the driver learns one picture.
export function CaptureDiagram({ positions, severityOf, governingOf, onOpen, activeId }: Props) {
  const running = positions.filter((r) => r.displayNumber !== null);
  const spares = positions.filter((r) => r.displayNumber === null);
  // Grouped by unit AND axle. Position codes are flat in the fixture
  // ("1".."10"), so there is nothing to parse out of them — and on a rig
  // the horse's axle 1 and the trailer's axle 1 are different axles.
  const axles = [
    ...new Map(
      running.map((r) => [`${r.position.vehicleId}:${r.position.axleNumber}`, r]),
    ).keys(),
  ];

  return (
    <div className="cap-diagram">
      {axles.map((axle) => {
        const group = running.filter(
          (r) => `${r.position.vehicleId}:${r.position.axleNumber}` === axle,
        );
        const unitLabel = group[0]?.position.unitLabel ?? group[0]?.context.fleetNumber;
        return (
          <div key={axle}>
            <p className="cap-unitband">{unitLabel}</p>
            <div className="cap-axle">
              {group.map((r) => (
                <PositionCell
                  key={r.position.id}
                  rig={r}
                  severity={severityOf(r.position.id)}
                  governing={governingOf(r.position.id)}
                  active={activeId === r.position.id}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </div>
        );
      })}
      {spares.length > 0 && (
        <>
          <p className="cap-unitband">Spare</p>
          <div className="cap-axle">
            {spares.map((r) => (
              <PositionCell
                key={r.position.id}
                rig={r}
                severity={severityOf(r.position.id)}
                governing={governingOf(r.position.id)}
                active={activeId === r.position.id}
                onOpen={onOpen}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SEVERITY_LABEL: Record<Severity, string> = {
  roadworthy: "OK",
  caution: "Check",
  "below-removal": "Report",
  unmeasured: "Not done",
};

function PositionCell({
  rig,
  severity,
  governing,
  active,
  onOpen,
}: {
  rig: RigPosition;
  severity: Severity;
  governing: number | null;
  active: boolean;
  onOpen: (positionId: string) => void;
}) {
  const name = rig.displayNumber === null ? "Spare" : `Position ${rig.displayNumber}`;
  return (
    <button
      type="button"
      // Any-order completion (FR-INS-048's walk-around reality): a driver
      // works round the vehicle in whatever order the yard allows, not in the
      // order a form dictates.
      className={`cap-pos cap-pos--${severity}${active ? " is-active" : ""}`}
      data-position-id={rig.position.id}
      aria-label={`${name}, ${rig.context.fleetNumber}, ${SEVERITY_LABEL[severity]}`}
      onClick={() => onOpen(rig.position.id)}
    >
      <span className="cap-pos-n">{rig.displayNumber ?? "S"}</span>
      <span className="cap-pos-v">{governing === null ? "—" : `${governing}mm`}</span>
      {/* NFR-USE-009: colour is never the only encoding. The badge says it in
          words, and it is the thing that survives direct sunlight. */}
      <span className="cap-pos-badge">{SEVERITY_LABEL[severity]}</span>
    </button>
  );
}
```

Create `web/src/capture/capture.css` with the layout. Every colour is a custom property from `tokens.ts` — the four `--status-*` names already exist and map to the four severities:

```css
.cap-pos {
  min-width: 64px;
  min-height: 64px; /* NFR-USE-004: gloves. */
  border: 2px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface);
  font-family: var(--font-condensed);
  display: grid;
  gap: 2px;
  place-items: center;
}
.cap-pos--roadworthy {
  border-color: var(--status-roadworthy);
}
.cap-pos--caution {
  border-color: var(--status-caution);
  background: color-mix(in srgb, var(--status-caution) 12%, var(--surface));
}
.cap-pos--below-removal {
  border-color: var(--status-below-removal);
  background: color-mix(in srgb, var(--status-below-removal) 14%, var(--surface));
}
.cap-pos--unmeasured {
  border-color: var(--status-unmeasured);
  border-style: dashed;
}
.cap-pos-badge {
  font-size: var(--text-eyebrow);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}
.cap-axle {
  display: flex;
  gap: 6px;
  justify-content: center;
  padding: 6px 0;
}
.cap-unitband {
  font-family: var(--font-condensed);
  font-size: var(--text-small);
  color: var(--ink-muted);
  text-transform: uppercase;
  letter-spacing: var(--tracking-eyebrow);
  margin: 8px 0 0;
}
```

> **`axleNumber` comes from the server plan's Task 4, which serves it for this.** The fixture's position codes are flat (`"1"`..`"10"`, `db/seeds/gen_seed_fixture.py`), so there is no axle to parse out of them, and `axle_number` is null on a spare — which is fine, because spares are grouped separately. The key includes `vehicleId` because on a rig the horse's axle 1 and the trailer's axle 1 are different axles that would otherwise collapse into one row.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/capture/rig.test.ts && make lint`
Expected: PASS, all six.

- [ ] **Step 6: Commit**

```bash
git add web/src/capture/rig.ts web/src/capture/rig.test.ts web/src/capture/CaptureDiagram.tsx web/src/capture/capture.css
git commit -m "feat(capture): TYRE-69 rig position projection and the axle diagram"
```

---

### Task 10: The keypad and the position sheet (TYRE-69)

The screen the whole POC is judged on. Four numbers per position, 27 positions on a superlink, and every interaction decision follows from that arithmetic: no native keyboard, no modal, no confirmation step, no navigation between positions.

**Files:**
- Create: `web/src/capture/Keypad.tsx`
- Create: `web/src/capture/PositionSheet.tsx`
- Create: `web/src/capture/PositionSheet.test.tsx`
- Modify: `web/src/capture/capture.css`

**Interfaces:**
- Consumes: `applyKey`, `newEntryState` from Task 5; `positionWarnings`, `severityFor`, `governingTread` from Task 3; `historyWarnings` from Task 4; `savePosition` from Task 6; `RigPosition` from Task 9.
- Produces: `<Keypad onKey granularityMm goLabel goTone />` and `<PositionSheet rig ctx initial onChange onDone onClose />`. `onChange` fires per keystroke (FR-OFF-005) and `initial` seeds the fields when a captured position is reopened (FR-OFF-006) — Task 11 wires both to `savePosition` and `loadDraft`.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/PositionSheet.test.tsx`. This is a component test, so it asserts what the driver sees rather than internal state.

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PositionSheet } from "./PositionSheet";
// Reuse the fixtures from rig.test.ts by exporting them from a shared helper
// if that is cleaner; duplicated inline here so the test reads on its own.

describe("PositionSheet", () => {
  it("enters three readings and a pressure with no native keyboard", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn();
    render(<PositionSheet {...props({ onDone })} />);

    // No input element anywhere: the OS keyboard costs a driver seconds per
    // field and covers half the screen (web/CLAUDE.md).
    expect(document.querySelector("input")).toBeNull();

    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveTextContent("13");
  });

  // FR-INS-029a: the driver never sees the words inner or outer, and the
  // prototype's Outer/Centre/Inner labels are not carried over (decision D-A).
  it("never shows the words inner or outer", () => {
    render(<PositionSheet {...props({})} />);
    expect(screen.queryByText(/\b(inner|outer)\b/i)).toBeNull();
  });

  // FR-INS-036, and CR-010 / OR-LEG-001: the tenant's configured policy, never
  // described as a legal limit.
  it("warns below the threshold without calling it a legal limit", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PositionSheet {...props({})} />);
    await enter(user, ["3", "3", "4"], "800");

    expect(screen.getByRole("alert")).toHaveTextContent(/replacement point/i);
    expect(screen.queryByText(/legal|roadworth|statutory/i)).toBeNull();
  });

  // FR-INS-040: the acknowledgement is recorded, so the driver has to see it
  // before the position closes — this is the one place the flow deliberately
  // does not auto-advance.
  it("holds a warned position until the driver acknowledges", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["3", "3", "4"], "800");

    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /seen it/i }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0].warnings[0]).toMatchObject({
      code: "FR-INS-036",
      response: "ACKNOWLEDGED",
    });
  });

  // NFR-OBS-007: measured, not assumed, and it cannot be added later.
  it("records how long the position took", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");
    await user.click(screen.getByRole("button", { name: /done ›/i }));

    expect(onDone.mock.calls[0][0].seconds).toBeGreaterThanOrEqual(0);
  });
});
```

Write `props()` and `enter()` as local helpers in the file. `props` builds a `RigPosition` and `CaptureContext` pair (copy the shape from `rig.test.ts`) and supplies a no-op `onChange`. `enter` must **drive the auto-advance rather than race it** — the 200ms hold means nine clicks in a row all land in field 0, where every digit after the second overshoots 35mm and restarts the buffer:

```tsx
// Fake timers, advanced deliberately between fields. On real timers this
// test passes or fails according to how fast jsdom happens to be today,
// and the failure mode is a green test over corrupt data.
async function enter(user: UserEvent, treads: string[], pressure: string) {
  for (const d of treads) {
    await user.click(screen.getByRole("button", { name: d, exact: true }));
    // A value that settles advances on the timer; one that does not (any
    // 0-3mm reading) needs the Next key. Pressing it either way is safe —
    // the timer's field guard makes an already-advanced field a no-op.
    await vi.advanceTimersByTimeAsync(250);
    await user.click(screen.getByRole("button", { name: /next ›/i }));
  }
  for (const d of pressure.split("")) {
    await user.click(screen.getByRole("button", { name: d, exact: true }));
  }
  await vi.advanceTimersByTimeAsync(250);
}
```



Set them up with `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach`, and build the user with `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` so clicks still resolve.

Add two more tests to this file, for the two props Task 11 depends on:

```tsx
// FR-OFF-006: reopening a captured position shows what was entered.
// Without this the draft survives a restart and the screen does not,
// which from the driver's side is the same as having lost it.
it("shows the saved readings when a position is reopened", () => {
  render(
    <PositionSheet
      {...props({})}
      initial={{
        positionId: "p1",
        vehicleId: "v1",
        tyreId: null,
        treads: [13, 13, 14],
        pressureKpa: 800,
        pressureTemperature: "UNKNOWN",
        damageFlag: false,
        note: null,
        seconds: 6,
        warnings: [],
      }}
    />,
  );
  expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveTextContent("13");
  expect(screen.getByLabelText(/Pressure/)).toHaveTextContent("800");
});

// FR-OFF-005 verbatim: EVERY entry, incrementally — not on completion.
// The flat-battery case happens mid-position, which is exactly the state
// a per-position save does not cover.
it("persists on the first digit, not on completion", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const onChange = vi.fn();
  render(<PositionSheet {...props({ onChange })} />);

  await user.click(screen.getByRole("button", { name: "1", exact: true }));

  expect(onChange).toHaveBeenCalled();
  expect(onChange.mock.calls[0][0].treads[0]).toBe(1);
});
```

`@testing-library/user-event` and `@testing-library/jest-dom` are not yet dependencies — add them: `cd web && npm install -D @testing-library/user-event @testing-library/jest-dom`, and add `import "@testing-library/jest-dom/vitest";` to `web/src/test/setup.ts` so `toHaveTextContent` exists.

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/PositionSheet.test.tsx`
Expected: FAIL — cannot resolve `./PositionSheet`.

- [ ] **Step 3: Write the keypad**

Create `web/src/capture/Keypad.tsx`:

```tsx
import type { EntryKey } from "./entry";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

// Not the OS keyboard. It covers half a phone screen, takes a beat to appear
// and its keys are sized for typing prose, not for a gloved thumb in the sun
// (NFR-USE-003/004). 108 numeric entries makes that difference minutes.
export function Keypad({
  onKey,
  granularityMm,
  goLabel,
  goTone,
}: {
  onKey: (key: EntryKey) => void;
  granularityMm: number;
  goLabel: string;
  goTone: "default" | "warn";
}) {
  return (
    <div className="cap-keypad">
      {DIGITS.map((d) => (
        <button key={d} type="button" className="cap-key" onClick={() => onKey({ type: "digit", digit: d })}>
          {d}
        </button>
      ))}
      {granularityMm === 0.5 ? (
        <button type="button" className="cap-key cap-key--alt" onClick={() => onKey({ type: "half" })}>
          ½
        </button>
      ) : (
        <button
          type="button"
          className="cap-key cap-key--alt"
          aria-label="Delete"
          onClick={() => onKey({ type: "delete" })}
        >
          ⌫
        </button>
      )}
      <button type="button" className="cap-key" onClick={() => onKey({ type: "digit", digit: "0" })}>
        0
      </button>
      <button
        type="button"
        className={`cap-key cap-key--go${goTone === "warn" ? " cap-key--warn" : ""}`}
        onClick={() => onKey({ type: "next" })}
      >
        {goLabel}
      </button>
    </div>
  );
}
```

At 0.5mm granularity the half key takes the delete key's slot; delete then lives on a long-press of the focused field, or the driver retypes — a fourth row would push the keypad off a small screen. Note it in the component and revisit in field trial.

- [ ] **Step 4: Write the position sheet**

Create `web/src/capture/PositionSheet.tsx`. The load-bearing parts, in full:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";

import type { CaptureContext } from "./captureContext";
import type { RigPosition } from "./rig";
import type { DraftPosition, RecordedWarning } from "./draft";
import type { EntryKey, EntryState } from "./entry";
import { applyKey, newEntryState } from "./entry";
import { governingTread, positionWarnings, severityFor } from "./warnings";
import { historyWarnings } from "./history";
import { Keypad } from "./Keypad";

// FR-INS-029a and decision D-A: numbered, not named. The driver never sees
// the words inner or outer, and the three fields sit left to right in the
// plan view — the same direction the diagram above them reads.
const FIELD_LABEL = (i: number, count: number) => `Tread reading ${i + 1} of ${count}`;

export function PositionSheet({
  rig,
  ctx,
  initial,
  onChange,
  onDone,
  onClose,
}: {
  rig: RigPosition;
  ctx: CaptureContext;
  // FR-OFF-006: reopening a captured position shows what was entered, not an
  // empty form. The draft is the source of truth and this is how it gets back
  // onto the screen.
  initial?: DraftPosition;
  // FR-OFF-005: "every entry … written incrementally". Fired per keystroke,
  // not per completed position — the flat-battery case is mid-position.
  onChange: (partial: DraftPosition) => void;
  onDone: (position: DraftPosition) => void;
  onClose: () => void;
}) {
  const count = ctx.config.treadReadingCount;
  const [state, setState] = useState<EntryState>(() =>
    initial
      ? { treads: [...initial.treads], pressureKpa: initial.pressureKpa, field: 0, buffer: "" }
      : newEntryState(count),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  // NFR-OBS-007. Wall clock from when the sheet opened, plus anything a
  // previous visit already cost — a driver who backs out and returns is
  // measured for both, which is the honest reading of "time per position".
  const openedAt = useRef(Date.now());
  const carried = useRef(initial?.seconds ?? 0);

  const opts = { treadReadingCount: count, granularityMm: ctx.config.treadGranularityMm };
  const entry = { treads: state.treads, pressureKpa: state.pressureKpa };
  const warnings = useMemo(
    () => [
      ...positionWarnings(entry, rig.position, ctx.config),
      ...historyWarnings(entry, rig.position, ctx, new Date()),
    ],
    [state, rig.position, ctx],
  );
  const complete = state.treads.every((t) => t !== null) && state.pressureKpa !== null;
  const held = complete && warnings.length > 0 && !acknowledged;

  function snapshot(from: EntryState, recorded: RecordedWarning[] = []): DraftPosition {
    return {
      positionId: rig.position.id,
      vehicleId: rig.position.vehicleId,
      tyreId: rig.position.tyreId,
      treads: from.treads,
      pressureKpa: from.pressureKpa,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: carried.current + Math.round((Date.now() - openedAt.current) / 1000),
      warnings: recorded,
    };
  }

  function press(key: EntryKey) {
    const result = applyKey(state, key, opts);
    setState(result.state);
    // FR-OFF-005, the verbatim requirement: every entry, incrementally. A
    // half-entered position survives a killed browser because it was written
    // as it was typed, not when it was finished.
    onChange(snapshot(result.state));
    if (result.settled) scheduleAdvance(result.state);
  }

  // React 19 removed the argument-less useRef overload.
  const timer = useRef<number | undefined>(undefined);
  function scheduleAdvance(from: EntryState) {
    window.clearTimeout(timer.current);
    const field = from.field;
    const expected = field >= count ? from.pressureKpa : from.treads[field];
    timer.current = window.setTimeout(() => {
      setState((current) => {
        if (current.field !== field) return current;
        // The prototype's holdThenAdvance guard, and the reason a fourth
        // pressure digit or a correction typed inside the beat is never
        // swallowed: if the value moved, the driver is still working.
        const now = field >= count ? current.pressureKpa : current.treads[field];
        if (now !== expected) return current;
        // Finishing a position is a decision. A sheet that closed itself
        // while the driver was reading a warning would defeat FR-INS-040.
        if (field >= count) return current;
        return applyKey(current, { type: "next" }, opts).state;
      });
    }, 200);
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function finish() {
    if (!complete) return;
    // FR-INS-040: the warning was displayed and the driver acted on it. One
    // tap does both — the alert has been on screen since the position
    // completed, so "Seen it" records the response and moves on, exactly as
    // the prototype's advance() does.
    if (held) setAcknowledged(true);
    const recorded: RecordedWarning[] = warnings.map((w) => ({
      code: w.code,
      enteredValue: w.enteredValue,
      response: w.requiresConfirmation ? "CONFIRMED" : "ACKNOWLEDGED",
    }));
    onDone(snapshot(state, recorded));
  }

  const governing = governingTread(state.treads);
  const severity = severityFor(warnings, complete);

  return (
    <section className="cap-sheet" aria-label={`Position ${rig.displayNumber ?? "spare"}`}>
      <header className="cap-sheet-head">
        <p className="cap-sheet-pos">
          {rig.displayNumber === null ? "Spare tyre" : `Position ${rig.displayNumber}`}
        </p>
        {/* FR-INS-026: the tyre identified from fitment state, shown for
            confirmation. FR-INS-027's dispute is a later ticket; the payload
            already carries whatever tyre id the driver was shown. */}
        <p className="cap-sheet-meta">
          {rig.context.fleetNumber} · {rig.position.axleClass.toLowerCase()}
          {rig.position.tyreCode ? ` · ${rig.position.tyreCode}` : ""}
        </p>
        <button type="button" className="cap-iconbtn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="cap-fields">
        {state.treads.map((value, i) => (
          <button
            key={i}
            type="button"
            className={`cap-fld${state.field === i ? " is-on" : ""}`}
            aria-label={FIELD_LABEL(i, count)}
            // Which field is live, for a screen reader and for a test that
            // needs to wait for the auto-advance rather than race it.
            aria-current={state.field === i ? "true" : undefined}
            onClick={() => press({ type: "focus", field: i })}
          >
            <span className="cap-fld-k">{i + 1}</span>
            <span className="cap-fld-u">mm</span>
            <span className="cap-fld-v">{value ?? "–"}</span>
          </button>
        ))}
        <button
          type="button"
          className={`cap-fld${state.field === count ? " is-on" : ""}`}
          aria-label="Pressure"
          aria-current={state.field === count ? "true" : undefined}
          onClick={() => press({ type: "focus", field: count })}
        >
          <span className="cap-fld-k">Press.</span>
          <span className="cap-fld-u">kPa</span>
          <span className="cap-fld-v">{state.pressureKpa ?? "–"}</span>
        </button>
      </div>

      <div className="cap-alerts">
        {warnings.map((w) => (
          <p key={w.code} role="alert" className={`cap-alert cap-alert--${severity}`}>
            {w.message}
          </p>
        ))}
        {complete && warnings.length === 0 && (
          <p className="cap-alert">Nothing to flag ({governing}mm).</p>
        )}
      </div>

      <Keypad
        // Next advances while the position is unfinished and finishes it
        // once it is complete. Wiring it straight to finish() strands a
        // 0-3mm tread: those never settle (30 is still under the 35mm
        // ceiling, so another digit is possible), finish() returns early on
        // an incomplete position, and the driver has no way forward — on
        // the exact reading the product exists to catch.
        onKey={(k) => (k.type === "next" && complete ? finish() : press(k))}
        granularityMm={ctx.config.treadGranularityMm}
        goLabel={held ? "Seen it ›" : complete ? "Done ›" : "Next ›"}
        goTone={held ? "warn" : "default"}
      />
    </section>
  );
}
```

Two things to note, both deliberate:

- **The go key never calls `applyKey({type:"next"})`.** Field-to-field movement is the auto-advance's job; the go key finishes the position. A driver who wants to skip a field taps it directly.
- **`aria-current` is how a test waits for the advance instead of racing it.** The 200ms hold means a helper that clicks nine digits in a row will pile them all into field 0 — every one after the second overshoots 35mm and restarts the buffer. Tests must wait for the next field to become current (Playwright) or drive the timer (`vi.useFakeTimers()`, jsdom). This is stated again in Tasks 11 and 12 because it is the single easiest way to write a green test over corrupt data.

Add the sheet, field and keypad styles to `capture.css`, keys at least 56px tall, tokens only.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `make web-test && make lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/test/setup.ts web/src/capture/Keypad.tsx web/src/capture/PositionSheet.tsx web/src/capture/PositionSheet.test.tsx web/src/capture/capture.css
git commit -m "feat(capture): TYRE-69 thumb keypad and per-position entry sheet"
```

---
### Task 11: Start, review, done — and the route that ties them together (TYRE-69)

The bookends. Starting requires the server (NFR-AVL-002) and is where the rig composition is confirmed; finishing must say so unambiguously, because a driver cannot be expected to infer success from the absence of an error.

**Files:**
- Create: `web/src/capture/CaptureStart.tsx`
- Create: `web/src/capture/CaptureReview.tsx`
- Create: `web/src/capture/CaptureDone.tsx`
- Create: `web/src/capture/CaptureFlow.tsx`
- Create: `web/src/capture/OutboxIndicator.tsx`
- Create: `web/src/capture/CaptureFlow.test.tsx`
- Modify: `web/src/routes.tsx` (add the capture route)
- Modify: `web/src/driver/DriverHome.tsx` (each task links to its capture)
- Modify: `web/src/dashboard/AppShell.tsx` (mount the outbox indicator)

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: the route `/capture/:vehicleId`, and `<OutboxIndicator />`.

- [ ] **Step 1: Write the failing test**

Create `web/src/capture/CaptureFlow.test.tsx`. Three assertions that are about the requirements rather than the layout:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CaptureFlow } from "./CaptureFlow";
import { clearDraft, db } from "./draft";

// CaptureFlow uses useCaptureContext -> useQuery, so an unwrapped render
// throws before any assertion runs. retry:false matters too: the default
// three retries would make the "refuses to start" test wait them out.
function renderFlow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CaptureFlow vehicleId="v1" taskId={null} />
    </QueryClientProvider>,
  );
}

// One position, so the flow reaches review in a handful of clicks. Copy the
// full shape from captureContext.test.ts; only the parts the flow reads are
// spelled out here.
const context = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  combination: null,
  positions: [
    {
      id: "p1",
      vehicleId: "v1",
      code: "1",
      sequence: 1,
      axleClass: "STEER",
      axleType: "FIXED",
      axleNumber: 1,
      isSpare: false,
      unitLabel: "Horse",
      tyreId: "ty1",
      tyreCode: "BAC-04217",
      previousGoverningMm: 14,
      previousReadingAt: "2026-07-23T06:00:00Z",
      fitmentSincePrevious: false,
      targetKpa: 800,
      warnUnderPct: 10,
      criticalUnderPct: 20,
      warnOverPct: 10,
      criticalOverPct: 20,
    },
  ],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
  },
  cohortWearRateMmPerMonth: { "STEER:FIXED": 0.8 },
};

// GET the context, POST the inspection. Routed on method so the order the
// component happens to call in does not decide whether the test passes.
function stubApi(submitStatus = 201) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: { method?: string }) =>
      Promise.resolve(
        init?.method === "POST"
          ? { ok: submitStatus < 400, status: submitStatus, json: () => Promise.resolve({ inspectionId: "i1" }) }
          : { ok: true, status: 200, json: () => Promise.resolve(context) },
      ),
    ),
  );
}

// Fake timers and an explicit Next after each field — for the same reason
// Task 10's enter() does it. Clicking nine digits straight through lands
// them all in field 1, where everything past the second overshoots 35mm
// and restarts the buffer: a green test over corrupt data.
async function capturePosition(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: /position 1/i }));
  for (const tread of [["1", "3"], ["1", "3"], ["1", "4"]]) {
    for (const d of tread) {
      await user.click(screen.getByRole("button", { name: d, exact: true }));
    }
    await vi.advanceTimersByTimeAsync(250);
  }
  for (const d of ["8", "0", "0"]) {
    await user.click(screen.getByRole("button", { name: d, exact: true }));
  }
  await vi.advanceTimersByTimeAsync(250);
  await user.click(screen.getByRole("button", { name: /done ›|seen it ›/i }));
}

beforeEach(async () => {
  vi.useFakeTimers();
  await db.open();
  await clearDraft();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await clearDraft();
});

// Every user in this file: userEvent must be told about the fake clock or
// its own internal delays never resolve.
const newUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe("CaptureFlow", () => {
  // NFR-AVL-002: "Starting a new inspection requires the server." Capture and
  // submit do not — but a driver must not be able to start against reference
  // data that never arrived, because every threshold would then be missing
  // and every warning would silently never fire.
  it("refuses to start when the reference data has not loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderFlow();

    expect(await screen.findByRole("alert")).toHaveTextContent(/connect|signal|load/i);
    expect(screen.queryByRole("button", { name: /start inspection/i })).toBeNull();
  });

  // NFR-USE-010: success is stated, not implied.
  it("confirms a submitted inspection in words", async () => {
    const user = newUser();
    stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/sent|recorded/i);
  });

  // FR-OFF-013 and FR-OFF-014 together: a permanent refusal is presented with
  // something to act on, and the readings are still on the device.
  it("presents a duplicate-window refusal without losing the inspection", async () => {
    const user = newUser();
    stubApi(409);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already inspected/i);
    expect(await db.table("outbox").count()).toBe(1);
  });

  // NFR-USE-011 / FR-OFF-006: the buffer is the source of truth, so a remount
  // is a reload and finds the work — with its numbers, not just its progress.
  it("resumes an in-progress inspection after a remount", async () => {
    const user = newUser();
    stubApi();
    const { unmount } = renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    unmount();

    renderFlow();
    await user.click(await screen.findByRole("button", { name: /position 1/i }));
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveTextContent("13");
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd web && npx vitest run src/capture/CaptureFlow.test.tsx`
Expected: FAIL — cannot resolve `./CaptureFlow`.

- [ ] **Step 3: Write the start screen**

Create `web/src/capture/CaptureStart.tsx`. Four things and nothing else — every extra control here is paid for on every inspection.

```tsx
import { useState } from "react";

import type { CaptureContext } from "./captureContext";
import { odometerRejection, odometerWarnings } from "./history";
import type { RecordedWarning } from "./draft";
import { Keypad } from "./Keypad";

export function CaptureStart({
  motive,
  attachedIds,
  onToggleAttached,
  onStart,
}: {
  // The unit the driver navigated to. FR-INS-064: only the motive unit's
  // odometer is recorded, and distance is never apportioned to a towed one.
  motive: CaptureContext;
  // Ticked member units, seeded from ALL of motive.combination.members —
  // which includes the motive unit, so it shows ticked — and narrowed only
  // by unticking. The motive unit cannot be unticked — it is the
  // inspection's subject and carries the odometer (FR-INS-064).
  attachedIds: string[];
  onToggleAttached: (vehicleId: string) => void;
  onStart: (init: {
    odometerKm: number | null;
    observedMemberVehicleIds: string[];
    warnings: RecordedWarning[];
  }) => void;
}) {
  const [odometer, setOdometer] = useState<string>(
    motive.lastOdometerKm === null ? "" : String(motive.lastOdometerKm),
  );
  const [touched, setTouched] = useState(false);
  // FR-INS-033 says warn and REQUIRE confirmation. Defaulting the box to
  // checked satisfies the control without the driver ever acting on it,
  // which is the same as not having the control.
  const [confirmed, setConfirmed] = useState(false);

  const value = odometer === "" ? null : parseInt(odometer, 10);
  const rejection = odometerRejection(value, motive);
  const warnings = odometerWarnings(value, motive, new Date());
  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  // Absent last odometer means an unpowered unit, which is the same case.
  // FR-INS-020: "trailer-only inspections have no odometer field at all".
  // Gate on what the unit IS, not on whether it happens to have a reading —
  // no vehicle has one until the first inspection writes it, so gating on
  // history means the timeline can never be started and FR-INS-032/033
  // never acquire a denominator.
  const wantsOdometer = motive.unitKind !== "TRAILER";

  function start() {
    if (rejection) return;
    if (warnings.length > 0 && !confirmed) return;
    onStart({
      odometerKm: wantsOdometer ? value : null,
      // attachedIds already contains the motive unit — it is a member of
      // its own combination and renders ticked-and-disabled. Prepending it
      // again would send a duplicate straight into the FR-INS-063
      // warning's entered_value.
      observedMemberVehicleIds: attachedIds,
      // FR-INS-033's confirmation governs the capture flow; DR-020 governs
      // the timeline. A confirmed implausible value still submits with the
      // inspection and is preserved on the warning record rather than written
      // to an append-only timeline that would keep it forever (DR-018).
      warnings: warnings.map((w) => ({
        code: w.code,
        enteredValue: w.enteredValue,
        response: "CONFIRMED" as const,
      })),
    });
  }

  return (
    <section aria-labelledby="start-heading">
      <h1 id="start-heading">{motive.fleetNumber}</h1>
      <p>{motive.positions.length} positions on this unit</p>

      {/* FR-INS-062: the driver CONFIRMS the rig, they do not compose it.
          What is coupled to what is fleet configuration a CONTROLLER sets
          before the trip (ManageAssignments); the driver's job here is to
          say whether that is what is actually in front of them. Pre-ticked
          from the served composition, which is the requirement's
          "defaulting to the last recorded composition".

          Unticking is FR-INS-063's observation, not an edit: it travels as
          observed_member_vehicle_ids and the server records the difference
          for a controller to reconcile (server plan, D5). Nothing here
          writes fleet state. */}
      {motive.combination && (
        <fieldset>
          <legend>Your rig</legend>
          <p className="cap-hint">Confirm what is coupled up. Untick anything that is not here.</p>
          {motive.combination.members.map((m) => (
            <label key={m.vehicleId}>
              <input
                type="checkbox"
                checked={attachedIds.includes(m.vehicleId)}
                disabled={m.vehicleId === motive.vehicleId}
                onChange={() => onToggleAttached(m.vehicleId)}
              />
              {m.fleetNumber}
              {m.descriptor ? ` · ${m.descriptor}` : ""}
            </label>
          ))}
          <p className="cap-hint">
            Something else coupled up? Finish this inspection and tell the office — they set
            the rig.
          </p>
        </fieldset>
      )}

      {wantsOdometer && (
        <fieldset>
          <legend>Odometer</legend>
          <p className="cap-odo">{odometer === "" ? "000 000" : odometer}</p>
          <p className="cap-hint">
            Last reading {motive.lastOdometerKm?.toLocaleString("en-ZA")} km
            {motive.lastOdometerAt
              ? `, ${Math.round((Date.now() - Date.parse(motive.lastOdometerAt)) / 86_400_000)} days ago`
              : ""}
          </p>
          <Keypad
            granularityMm={1.0}
            goLabel="Done ›"
            goTone="default"
            onKey={(k) => {
              // The first digit REPLACES the prefill. Appending to a
              // prefilled 412180 gives 4121801, which is both wrong and
              // the kind of wrong a driver will not notice.
              if (k.type === "digit")
                setOdometer((o) => (touched ? o + k.digit : k.digit));
              if (k.type === "digit") setTouched(true);
              if (k.type === "delete") setOdometer("");
            }}
          />
          {/* FR-INS-032 is a rejection, not a warning: BR-INS-002 is
              unconditional, so refusing here saves the driver discovering it
              after the walk-around. */}
          {rejection && <p role="alert">{rejection}</p>}
          {warnings.map((w) => (
            <label key={w.code}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {w.message}
            </label>
          ))}
        </fieldset>
      )}

      {/* NFR-PRV-006. Most drivers are on their own phone, and this sentence
          has to be true — Task 2's storage test is what keeps it true. */}
      <p className="cap-notice">
        While you are working, this inspection is saved on your phone. Nothing else about the fleet
        is stored here.
      </p>

      <button type="button" onClick={start} disabled={rejection !== null}>
        Start inspection
      </button>
    </section>
  );
}
```

**On starting, `CaptureFlow` loads a capture context for the motive unit and every ticked trailer** — one `GET /api/capture/vehicles/{id}` each, all while the driver still has signal (FR-OFF-001) — then hands the array to `rigPositions` for the continuous 1..n the driver walks (FR-VEH-034). Each unit keeps its own configuration, its own thresholds and its own positions; the projection is display only.

**The composition is the controller's, not the driver's.** `motive.combination` is what a `CONTROLLER` set for this trip (`ManageAssignments`), served by the capture context and pre-ticked here — that is FR-INS-062's "defaulting to the last recorded composition", satisfied properly rather than by guesswork. `CaptureFlow` seeds `attachedIds` from `combination.members` and loads a capture context for each ticked unit.

**Unticking is an observation, not an edit.** FR-INS-063 requires the system to permit a driver to begin with a composition that differs from the record. Unticking does that: the reduced set travels as `observed_member_vehicle_ids`, the server writes an `FR-INS-063` warning, and a controller reconciles it. **Adding** a trailer the record does not know about is deliberately *not* built — under FR-AUT-005 the driver has no scoped way to identify an arbitrary unit, and inventing a fleet-wide unit picker on a driver's phone would hand out exactly the configuration authority this design is keeping with the controller. That half of FR-INS-063 is partial and is recorded as such in *What this plan does not build* and in the questions file. Do not close FR-INS-063 on the epic.

- [ ] **Step 4: Write the review and done screens**

`CaptureReview.tsx` shows the counts, the elapsed time, everything flagged, and the two free-text fields the paper sheet has. Completeness is reported per member unit as well as for the rig (FR-INS-065), from `completenessByUnit` — the rig total is the sum, so the two cannot disagree.

```tsx
export function CaptureReview({
  contexts,
  draft,
  onSubmit,
}: {
  contexts: CaptureContext[];
  draft: Draft;
  onSubmit: (patch: { comment: string | null; defectReport: string | null }) => void;
}) {
  const done = new Set(Object.keys(draft.positions));
  const units = completenessByUnit(contexts, done);
  const [comment, setComment] = useState("");
  const [defect, setDefect] = useState("");
  const flagged = Object.values(draft.positions).flatMap((p) =>
    p.warnings.map((w) => ({ positionId: p.positionId, ...w })),
  );

  return (
    <section aria-labelledby="review-heading">
      <h1 id="review-heading">Review</h1>
      {/* FR-INS-065: which unit is short, not just how many are missing. */}
      <ul>
        {units.map((u) => (
          <li key={u.vehicleId}>
            {u.fleetNumber}: {u.done} of {u.total} done
          </li>
        ))}
      </ul>

      <h2>What the app found</h2>
      {flagged.length === 0 ? (
        <p>Nothing to flag.</p>
      ) : (
        <ul>
          {flagged.map((f) => (
            <li key={`${f.positionId}-${f.code}`}>
              {f.code} — {f.enteredValue}
            </li>
          ))}
        </ul>
      )}

      {/* FR-INS-030a and FR-INS-030b are different fields with different
          destinations: the defect report goes to the workshop queue, not to
          the tyre controller, and the label has to say so or drivers will use
          whichever box is nearer. */}
      <label>
        Comments about the tyres
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <label>
        Anything else wrong with the vehicle? Goes to the workshop, not the tyre office.
        <textarea value={defect} onChange={(e) => setDefect(e.target.value)} />
      </label>

      <button
        type="button"
        onClick={() => onSubmit({ comment: comment || null, defectReport: defect || null })}
      >
        Submit inspection
      </button>
    </section>
  );
}
```

`CaptureDone.tsx` is NFR-USE-010's whole requirement. Three states, each stated plainly:

```tsx
export function CaptureDone({ state, lastStatus }: { state: "sent" | "queued" | "failed"; lastStatus: number | null }) {
  if (state === "sent") {
    return (
      <section role="status">
        <p className="cap-success">✓</p>
        <h1>Inspection sent</h1>
        <p>The tyre office has it.</p>
      </section>
    );
  }
  if (state === "queued") {
    // A success state, not an error. The driver's work is done and safe, and
    // implying otherwise is what makes people re-enter an inspection they
    // already completed.
    return (
      <section role="status">
        <p className="cap-success">✓</p>
        <h1>Inspection saved</h1>
        <p>It will send by itself when you have signal. You can close the app.</p>
      </section>
    );
  }
  // FR-OFF-013: a supported recovery action, in plain language (NFR-USE-005).
  // "Submission failed" tells a driver nothing they can act on; naming the
  // duplicate window tells them exactly who to call and why.
  return (
    <section role="alert">
      <h1>This one needs the office</h1>
      <p>
        {lastStatus === 409
          ? "This vehicle was already inspected a short while ago. Your readings are saved — call the tyre office and they can accept it."
          : "The office could not accept this inspection. Your readings are saved — call the tyre office."}
      </p>
    </section>
  );
}
```

- [ ] **Step 5: Write the outbox indicator**

This needs one more package — `dexie-react-hooks`, which ships `useLiveQuery`: `cd web && npm install dexie-react-hooks`. A one-shot `listOutbox()` on mount would show a stale count for the rest of the session, because `queueDraft` and `attemptSend` run inside `CaptureFlow` with nothing connecting them to this component.

`OutboxIndicator.tsx`, mounted in `AppShell` so it is visible everywhere rather than only inside capture — a driver who navigated away still needs to know something is waiting.

```tsx
export function OutboxIndicator() {
  // liveQuery, not a one-shot read: queueDraft and attemptSend run inside
  // CaptureFlow with nothing connecting them to this component, so a
  // mount-time read would show a stale count for the whole session.
  const entries = useLiveQuery(() => listOutbox(), [], [] as OutboxEntry[]);

  useEffect(() => {
    // FR-OFF-009: on app-open, and whenever connectivity returns while the
    // app is open. Never Background Sync — iOS Safari has none and ADR-0009
    // settled that nothing here depends on it.
    void flushOutbox();
    const onOnline = () => void flushOutbox();
    window.addEventListener("online", onOnline);
    // FR-OFF-012's schedule needs a pulse while the app is open.
    const stopHeartbeat = startOutboxHeartbeat();
    return () => {
      window.removeEventListener("online", onOnline);
      stopHeartbeat();
    };
  }, []);

  if (entries.length === 0) return null;
  // FR-OFF-013: a permanent refusal is not 'waiting to send' — nothing is
  // going to happen to it without a person, and saying otherwise leaves a
  // driver watching a queue that will never drain.
  const waiting = entries.filter((e) => e.state !== "failed");
  const blocked = entries.filter((e) => e.state === "failed");
  const stale = waiting.filter((e) => isStale(e));

  return (
    <div className="cap-outbox" role="status">
      {/* NFR-USE-009: the count is in words, not only a coloured badge. */}
      {waiting.length > 0 && (
        <span>
          {waiting.length} inspection{waiting.length === 1 ? "" : "s"} waiting to send
        </span>
      )}
      {blocked.length > 0 && (
        <span role="alert">
          {blocked.length} inspection{blocked.length === 1 ? "" : "s"} need the office
        </span>
      )}
      {stale.length > 0 && (
        <span role="alert">Waiting over two days — please find signal and sync.</span>
      )}
      {/* FR-OFF-010 */}
      <button type="button" onClick={() => void flushOutbox({ force: true })}>
        Sync now
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Wire the route**

In `web/src/routes.tsx`:

```tsx
<Route path="/capture/:vehicleId" element={<CaptureRoute />} />
```

```tsx
function CaptureRoute() {
  const { vehicleId } = useParams();
  const [params] = useSearchParams();
  const can = useCan("CaptureInspection");
  const settled = useActorSettled();
  if (!settled) return null;
  // A blank screen is not NFR-USE-005. RequireCapability hides silently,
  // which is right for a menu item and wrong for a destination someone
  // navigated to.
  if (!can) return <p role="alert">You do not have permission to capture inspections.</p>;
  if (!vehicleId) return <NotFound />;
  return <CaptureFlow vehicleId={vehicleId} taskId={params.get("taskId")} />;
}
```

In `DriverHome.tsx`, each task becomes the one tap into the work — FR-INS-048 already shows the driver their tasks:

```tsx
<li key={t.id}>
  <Link to={`/capture/${t.vehicleId}?taskId=${t.id}`}>
    {t.fleetNumber} — due {new Date(t.dueAt).toLocaleDateString()}
    {t.overdue ? " (overdue)" : ""}
  </Link>
</li>
```

`CaptureFlow.tsx` itself is the screen state machine: it loads the contexts with `useCaptureContext` for each confirmed unit, resumes an existing draft with `loadDraft` on mount (FR-OFF-006), holds `screen` as `"start" | "capture" | "review" | "done"`, and persists through `savePosition` / `saveHeader` on every change rather than holding the truth in React state.

Three things it must do that are easy to miss:

- **Render progress above the diagram during capture**, not only at review: `{done} of {total} done` for the rig, and `completenessByUnit` per member unit (FR-INS-065). A driver mid-walk-around needs to know which unit is short.
- **Seed `attachedIds` with every member id** — `motive.combination?.members.map((m) => m.vehicleId) ?? [motive.vehicleId]`. The motive unit is a member of its own combination and its checkbox is disabled, so seeding only the trailers renders the driver own truck as not-here and unfixable.
- **Pass `initial` to `PositionSheet`** from `draft.positions[id]` when reopening a captured position, and wire its `onChange` to `savePosition` (FR-OFF-005/006).
- **Compute and store completeness on submit.** `app.inspection.completeness_pct` defaults to 100, so a partial inspection submitted without it is recorded as complete — see the server-plan note in Task 7's Interfaces.

- [ ] **Step 7: Run everything and verify**

Run: `make check`
Expected: PASS across db, api and web.

- [ ] **Step 8: Commit**

```bash
git add web/src/capture web/src/routes.tsx web/src/driver/DriverHome.tsx web/src/dashboard/AppShell.tsx
git commit -m "feat(capture): TYRE-69 capture flow from start through review to a confirmed submit"
```

---

### Task 12: Mobile browser tests and the M2 acceptance run (TYRE-70)

The Playwright config says in as many words that mobile projects arrive with the capture app. They arrive here. A capture flow that passes in jsdom and on a desktop viewport has not been tested — the whole design rests on thumb reach, target size and legibility at phone dimensions.

**Files:**
- Modify: `web/playwright.config.ts`
- Create: `web/e2e/capture.spec.ts`
- Modify: `web/CLAUDE.md` (the browser-tests section says these arrive with TYRE-4; say they have)

**Interfaces:**
- Consumes: the running dev stack — `make api-run` over a seeded database, `vite dev` on :5173, dev actor headers.

- [ ] **Step 1: Add the mobile projects**

In `web/playwright.config.ts`, alongside the existing `chromium` project:

```ts
projects: [
  // capture.spec.ts submits, and the FR-INS-038 window is tenant state in
  // one shared database — running it on three projects would have the
  // second and third refused by the first. Gate it here rather than with a
  // conditional skip inside the file: Playwright's skip callback takes one
  // argument, not two, so the two-argument form does not typecheck.
  { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /capture\.spec/ },
  // The capture app is judged at phone dimensions or not at all: thumb reach,
  // 44px targets and sunlight legibility are the design, not the styling.
  // Pixel 7 and iPhone 14 bracket the sizes BAC's drivers actually carry.
  { name: "android", use: { ...devices["Pixel 7"] } },
  { name: "ios", use: { ...devices["iPhone 14"] }, testIgnore: /capture\.spec/ },
],
```

Playwright's `devices["iPhone 14"]` runs WebKit — check `npx playwright install webkit` has run, and if WebKit is not available in CI, keep the project locally and gate it out of the CI matrix rather than deleting it. iOS is where the storage-eviction risk FR-OFF-020 exists for actually lives.

- [ ] **Step 2: Write the specs**

Create `web/e2e/capture.spec.ts`. Four flows, each one a requirement — plus a fifth, smaller spec that runs on every project.

**The fixture seeds no inspection tasks, so `/my` is not the way in.** `db/seeds/gen_seed_fixture.py` creates zero `inspection_task` rows — `web/e2e/smoke.spec.ts` asserts `"Nothing due."` for exactly this reason — so `DriverHome` renders no links to follow. Seeding tasks would break that existing assertion. These specs therefore enter through `GET /api/my/vehicles`, which is already implemented and scoped to the driver (FR-AUT-005), and navigate straight to `/capture/{id}`. Note also that the seeded **fleet numbers** are `HORSE`, `LINK6`, `LINK12` — `BAC039SP` is the *registration* — so any locator matching `/BAC/` on a fleet number finds nothing.

**And FR-INS-038 makes these specs order-dependent by construction.** The duplicate window is tenant state in a shared database: four parallel workers across three projects submitting the same vehicle would have every submit after the first refused with a 409. The file runs serially, on one project, with a vehicle budget:

The seeded fixture makes this tight, and the numbers matter. `driver1` currently holds `veh1` (HORSE) and `veh3` (LINK12); `comb1` is `veh1 + veh2 + veh3`. The window keys **per unit carrying readings**, so one rig submit consumes all three and leaves nothing for anything else:

| Spec | Unit | Rig? | Submits |
| --- | --- | --- | --- |
| 1 — full capture and the agreement check | veh1 | untick trailers | yes |
| 2 — offline capture and reconnect | veh3 | solo already | yes |
| 3 — restart mid-capture | veh1 | untick trailers | no |
| 4 — the duplicate window | veh1 | untick trailers | yes, and expects the refusal because spec 1 already submitted veh1 |
| 5 — the rig | veh1 + veh2 + veh3 | confirmed | **no** — asserts the queued payload, then clears it |

Spec 4 depending on spec 1 is deliberate: serial mode makes it explicit rather than accidental.

> **This file is one-shot per seed.** Spec 1 submits veh1 with a fresh `client_uuid` every run, so a second `make e2e` inside the four-hour window is refused at the first spec. CI is safe — it builds a fresh stack each time — but locally the target needs a reseed first. Make `make e2e` depend on `db-reset`, or state the requirement in the target's help text; do not let it fail mysteriously on the second run. Spec 5 runs last and deliberately stops at the outbox — submitting a rig would refuse on all three units and there is nothing left to test with afterwards. It is not a weaker test for that: **BR-VEH-003 breaks in the payload**, so the payload is exactly where to catch it.

```ts
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The duplicate window (FR-INS-038) is tenant state in one shared database,
// so these cannot run in parallel or across projects — the second submit of
// a vehicle is refused by design, whichever worker gets there first. Thumb
// reach and target size are project-dependent and live in reach.spec.ts;
// the submit contract is not.
test.describe.configure({ mode: "serial" });

// The seeded driver and their tenant (db/seeds/gen_seed_fixture.py, mirrored
// in web/src/api/devTenant.ts). Identity is the dev actor headers, which
// exist only under import.meta.env.DEV — hence vite dev, never a build.
const DRIVER = "b85aef08-6081-80db-9d4d-dad38ae40545";
const TENANT = "11111111-1111-1111-1111-111111111111";
const HEADERS = { "X-Tenant-ID": TENANT, "X-User-ID": DRIVER };

// The 23/07 sheet's own first-position readings, so what lands in the
// database after a run is what a real inspection contained.
const TREADS = [
  ["1", "3"],
  ["1", "3"],
  ["1", "4"],
];
const PRESSURE = ["8", "0", "0"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([user, tenant]) => {
      window.localStorage.setItem("tyre.dev.user-id", user);
      window.localStorage.setItem("tyre.dev.tenant-id", tenant);
    },
    [DRIVER, TENANT],
  );
});

// FR-AUT-005 scopes this to the driver's own units, so it is both the entry
// point and a check that the scope predicate holds.
async function assignedVehicles(request: APIRequestContext) {
  const res = await request.get("/api/my/vehicles", { headers: HEADERS });
  expect(res.ok()).toBeTruthy();
  const vehicles = (await res.json()) as { id: string; fleetNumber: string }[];
  expect(vehicles.length).toBeGreaterThanOrEqual(2);
  return vehicles;
}

// Solo capture: untick every trailer the controller has coupled to this
// unit, so the specs that submit consume one unit's window rather than
// three. Unticking is FR-INS-063's observation and the server records it —
// which these specs also, incidentally, exercise.
async function startInspection(page: Page, vehicleId: string, rig: "solo" | "whole" = "solo") {
  await page.goto(`/capture/${vehicleId}`);
  if (rig === "solo") {
    // getByRole's own disabled option, not filter({ hasNot }) — hasNot
    // matches DESCENDANTS, and an <input> has none, so the disabled motive
    // checkbox would be included and uncheck() would hang on it.
    const trailers = page.getByRole("checkbox", { disabled: false });
    for (const box of await trailers.all()) {
      if (await box.isChecked()) await box.uncheck();
    }
  }
  await page.getByRole("button", { name: /start inspection/i }).click();
}

// Each field advances itself once no further digit could change it, so the
// spec WAITS for that rather than racing the 200ms hold. Typing straight on
// would pile every digit into field 1, where each one past the second
// overshoots 35mm and restarts the buffer — a green run over corrupt data.
async function enterField(page: Page, digits: string[], nextLabel: RegExp) {
  for (const d of digits) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  // A 0-3mm reading never settles (30 is still under the 35mm ceiling), so
  // it needs the Next key. Pressing it either way is safe: once the field
  // has already advanced, Next simply moves on from the next one — which is
  // why the wait comes first.
  if (!(await page.getByLabel(nextLabel).getAttribute("aria-current"))) {
    await page.getByRole("button", { name: /next ›/i }).click();
  }
  await expect(page.getByLabel(nextLabel)).toHaveAttribute("aria-current", "true");
}

async function capturePosition(page: Page, index: number, treads: string[][] = TREADS) {
  await page.locator("[data-position-id]").nth(index).click();
  await enterField(page, treads[0], /Tread reading 2 of 3/);
  await enterField(page, treads[1], /Tread reading 3 of 3/);
  await enterField(page, treads[2], /Pressure/);
  for (const d of PRESSURE) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  await page.getByRole("button", { name: /done ›|seen it ›/i }).click();
}

async function captureAll(page: Page) {
  const total = await page.locator("[data-position-id]").count();
  for (let i = 0; i < total; i++) await capturePosition(page, i);
  return total;
}

// CaptureDone and the shell's OutboxIndicator both render role=status (and
// both render role=alert on a refusal), so an unscoped getByRole resolves
// two elements and throws under strict mode. Scope to the flow.
const done = (page: Page) => page.locator("main").getByRole("status");
const failed = (page: Page) => page.locator("main").getByRole("alert");

async function submit(page: Page) {
  await page.getByRole("button", { name: /review and submit/i }).click();
  await page.getByRole("button", { name: /submit inspection/i }).click();
}

test("a driver captures a whole vehicle, sees it confirmed, and agrees with the database", async ({
  page,
  request,
}) => {
  const [a] = await assignedVehicles(request);
  await startInspection(page, a.id);

  // Decision D-C: the capture app's leg of the three-way agreement is one
  // vehicle at the moment of entry. The fleet-wide 19/11/9 leg arrives with
  // TYRE-41; do not assert it here.
  //
  // Capture the FIRST position below the threshold and the rest above it.
  // Capturing everything at 13/13/14 against a 4mm threshold makes both
  // sides of the comparison zero, and 0 === 0 pins nothing at all.
  await capturePosition(page, 0, [["3"], ["3"], ["4"]]);
  const cells = await page.locator("[data-position-id]").count();
  for (let i = 1; i < cells; i++) await capturePosition(page, i);
  const total = cells;
  await page.getByRole("button", { name: /review and submit/i }).click();
  const flagged = await page.getByRole("listitem").filter({ hasText: /FR-INS-036/ }).count();
  await page.getByRole("button", { name: /submit inspection/i }).click();

  // NFR-USE-010: stated, not inferred from the absence of an error.
  await expect(done(page)).toContainText(/sent|recorded/i);

  // Re-read the context the way the dashboard will. previousGoverningMm is
  // now the reading just submitted, so this compares what the app flagged
  // against what the database holds — not the app against itself.
  const res = await request.get(`/api/capture/vehicles/${a.id}`, { headers: HEADERS });
  const ctx = await res.json();
  const below = ctx.positions.filter(
    (p: { previousGoverningMm: number | null }) =>
      p.previousGoverningMm !== null && p.previousGoverningMm <= ctx.config.removalThresholdMm,
  ).length;

  expect(below).toBe(flagged);
  expect(total).toBe(ctx.positions.length);
});

test("capture continues with the network cut and syncs on reconnect", async ({
  page,
  context,
  request,
}) => {
  const [, b] = await assignedVehicles(request);
  await startInspection(page, b.id);

  // FR-OFF-001: no connectivity at any point AFTER reference data has loaded.
  // Cut it here, not before — starting requires the server (NFR-AVL-002).
  await context.setOffline(true);
  await captureAll(page);
  await submit(page);

  // FR-OFF-005 / FR-OFF-014: queued, safe, and said so.
  await expect(done(page)).toContainText(/saved|will send/i);
  await expect(page.getByText(/waiting to send/i)).toBeVisible();

  // FR-OFF-009 / FR-OFF-010: on reconnect, while the app is open.
  await context.setOffline(false);
  await page.getByRole("button", { name: /sync now/i }).click();
  await expect(page.getByText(/waiting to send/i)).toBeHidden();
});

test("an inspection survives a browser restart mid-capture", async ({ page, request }) => {
  const [a] = await assignedVehicles(request);
  await startInspection(page, a.id);
  await capturePosition(page, 0);
  await capturePosition(page, 1);
  await capturePosition(page, 2);

  // FR-OFF-006 / NFR-USE-011: the flat-battery case, and the one a driver
  // will never forgive. A reload is a restart as far as the buffer is
  // concerned — the store is the source of truth, not React state.
  await page.reload();

  await expect(page.getByText(/3 of/i)).toBeVisible();
  // The readings themselves, not just the count: a resumed inspection that
  // kept its progress bar and lost its numbers would pass a weaker check.
  await page.locator("[data-position-id]").first().click();
  await expect(page.getByLabel(/Tread reading 1 of 3/)).toContainText("13");
});

test("a rig walks as one sequence and attributes every reading to its own unit", async ({
  page,
  request,
}) => {
  // FR-INS-060/061 and BR-VEH-003, which is the one that breaks silently.
  // The driver sees a continuous 1..n across the horse and both trailers;
  // what is SENT is (vehicle_id, position_id) per unit, and the rig number
  // appears nowhere. If the projection ever leaked into the payload, every
  // trailer's tyres would be filed against the horse.
  const [a] = await assignedVehicles(request);
  await startInspection(page, a.id, "whole");

  // FR-INS-062: the composition a controller set, pre-ticked. Three units.
  const contexts = await request.get(`/api/capture/vehicles/${a.id}`, { headers: HEADERS });
  const combination = (await contexts.json()).combination;
  expect(combination.members).toHaveLength(3);

  const total = await captureAll(page);
  expect(total).toBeGreaterThan(20); // a superlink, not one unit

  // FR-VEH-034: continuous across member units, computed for the screen.
  // Count the RUNNING positions, not every cell — spares carry no rig
  // number and are drawn separately, so total includes three of them and
  // there is no "Position 29".
  const running = await page.getByRole("button", { name: /^Position \d+,/ }).count();
  await expect(page.getByRole("button", { name: /^Position 1,/ })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^Position ${running},`) })).toBeVisible();

  await page.getByRole("button", { name: /review and submit/i }).click();
  await page.getByRole("button", { name: /submit inspection/i }).click();

  // Stop at the outbox. Read what WOULD go on the wire: every reading
  // carries the owning unit, at least two distinct units appear, and no
  // rig-level number is transmitted anywhere.
  const queued = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tyre-capture");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise<unknown[]>((resolve) => {
      const all = db.transaction("outbox").objectStore("outbox").getAll();
      all.onsuccess = () => resolve(all.result);
    });
  });

  const payload = (queued as { payload: { readings: { vehicle_id: string }[] } }[])[0].payload;
  const units = new Set(payload.readings.map((r) => r.vehicle_id));
  expect(units.size).toBeGreaterThanOrEqual(2);
  for (const member of combination.members) {
    expect(units.has(member.vehicleId)).toBe(true);
  }
  // BR-VEH-003 as amended by E2: never stored AND never transmitted.
  expect(JSON.stringify(payload)).not.toMatch(/rig_position|"sequence"/);

  // Leave the fixture as we found it — this one never sends.
  await page.evaluate(() => indexedDB.deleteDatabase("tyre-capture"));
});

test("a second inspection inside the window is refused permanently", async ({ page, request }) => {
  // Depends on the first spec having submitted vehicle A, which serial mode
  // guarantees. FR-INS-038 is about the VEHICLE and a wall-clock window, not
  // about this browser — and a replayed client_uuid is not a second
  // inspection, which is the distinction the whole outbox turns on.
  const [a] = await assignedVehicles(request);
  await startInspection(page, a.id);
  await captureAll(page);
  await submit(page);

  // FR-OFF-013: presented, named, and with something the driver can act on.
  await expect(failed(page)).toContainText(/already inspected/i);
  await expect(failed(page)).toContainText(/saved/i);

  // The outbox must NOT be retrying it — a permanent refusal is not
  // "waiting to send", and a phone hammering it helps nobody.
  await expect(page.getByText(/waiting to send/i)).toBeHidden();
  await expect(page.getByText(/need the office/i)).toBeVisible();
});
```

Add a second, tiny spec that **does** run on every project, since that is what the mobile viewports are for — reach and legibility, no submits:

```ts
// web/e2e/reach.spec.ts — runs on chromium, android and ios.
test("every capture target is thumb-sized", async ({ page, request }) => {
  const [a] = await assignedVehicles(request);
  await page.goto(`/capture/${a.id}`);
  await page.getByRole("button", { name: /start inspection/i }).click();
  await page.locator("[data-position-id]").first().click();

  // NFR-USE-004: gloves. 44px is the smallest a gloved thumb hits reliably.
  for (const key of ["1", "5", "0"]) {
    const box = await page.getByRole("button", { name: key, exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
});
```

`make e2e` currently runs `playwright install chromium` only — add `webkit` and the Chromium-based mobile emulation it already covers, or the `ios` project fails to launch. Check the target in the Makefile before running.

- [ ] **Step 3: Run the M2 acceptance run**

This is the epic's acceptance criterion and it is a measured run, not a passing test:

> A full inspection of one real vehicle completed on a phone **in airplane mode**, synced on reconnect, visible in the database with correct positions.

**Run `make db-reset` first.** The automated specs above consume the FR-INS-038 window on every unit of `comb1`, so an M2 run straight after them is refused before it starts — and M2 is the whole rig, confirmed, not a solo unit. Do it on a real device against the dev stack on the same network, or `context.setOffline(true)` on the `android` project if no device is available — and **say which**, because they are not the same evidence. Record:

- the vehicle and its position count;
- **the wall-clock duration**, against NFR-USE-001's 3 minutes for ten positions and NFR-USE-001a's 7 minutes for 26;
- the per-position median the app itself recorded (NFR-OBS-007) — the two should agree, and a gap between them is worth understanding before the pilot;
- confirmation that the readings landed against the right `(vehicle_id, position_id)` pairs, **including on a trailer** — tick at least one trailer at the start screen and check afterwards that its readings carry the trailer's `vehicle_id`, not the horse's. This is where BR-VEH-003's never-transmitted rig number would surface as a wrong answer, and it is the single most valuable assertion in the M2 run.

Write the result into the TYRE-70 ticket. If the median misses the target, that is a finding about the three-reading model and it belongs in the ticket rather than in a quiet retry — NFR-OBS-007 exists precisely so this is measured rather than assumed.

- [ ] **Step 4: Run everything**

Run: `make e2e` (with `make api-run` in another terminal over a seeded database), then `make check`.
Expected: PASS on all three projects.

- [ ] **Step 5: Commit**

```bash
git add web/playwright.config.ts web/e2e/capture.spec.ts web/CLAUDE.md
git commit -m "test(web): TYRE-70 mobile capture flows and the M2 airplane-mode run"
```

---

## What this plan does not build

Named so nobody discovers them mid-task and quietly adds them.

- **Composition *management*.** Rig capture is fully in this slice — the controller-set composition is served, pre-ticked, confirmed by the driver, and every member unit's readings are attributed to the unit that owns the position. What is not here is the controller's surface for *setting* a composition: creating a dated `app.combination` and its members, under `ManageAssignments`. The fixture seeds one, so capture works end to end; a new tenant would have nothing to confirm. **Needs a ticket** before pilot, alongside FR-INS-049's schedule-setting surface.
- **The add half of FR-INS-063.** A driver can untick a unit that is not actually coupled up, and that observation reaches the server. They cannot *add* a unit the recorded composition does not name — see Task 11 for why, and do not treat FR-INS-063 as closed.

- **Photographs.** FR-INS-041 prompts for one and this plan raises the prompt, but capture, compression (FR-OFF-017), the separate queue and deferred upload (FR-OFF-018/019) are a slice of their own. The submit path is complete without them: FR-OFF-018 requires inspection data to submit *where photograph upload fails*, so photos can never be a submit gate. Task 3's `promptPhoto` flag is the hook they attach to.
- **FR-INS-027's tyre dispute.** The payload already carries whatever `tyre_id` the driver was shown, and the server accepts a mismatch and records it (FR-OFF-016). The UI for *reporting* a different tyre is not here.
- **FR-INS-024/025** damage type and wear pattern, and **FR-INS-030c**'s dual-pair note. `damageFlag` and `note` exist on the draft and travel in the payload; no control sets them yet.
- **FR-INS-022a's hot/cold control.** The payload carries `pressure_temperature` and it is always `UNKNOWN`. A control is one tap per position and the three-minute budget should decide where it goes — probably once per inspection, not once per tyre.
- **A service worker or PWA install.** `vite.config.ts` says PWA config arrives with TYRE-4; it can arrive after the flow works, and ADR-0009 means nothing in this design depends on it.
- **Real authentication.** Identity stays the dev actor headers until FR-AUT-001.

## Self-review

Run before handing over.

**Spec coverage.** Every at-capture warning in the design's table has a task: FR-INS-036/041 in Task 3, FR-INS-037/031a in Task 3, FR-INS-034/035 in Task 4, FR-INS-032/033 in Task 4. FR-OFF-002/003 in Task 2; 005/006 in Task 6; 009/010/011/012/013/014/020 in Task 8 and Task 11. FR-INS-060/061/065 and FR-VEH-034 in Task 9; 062/063 in Task 11. NFR-OBS-007 in Tasks 6 and 10. NFR-USE-010 in Task 11. NFR-PRV-006 in Tasks 2 and 11. TYRE-68's DoD in Task 1; TYRE-70's in Task 12.

**Known gaps, deliberately left.** The *add* half of FR-INS-063 — beginning with a unit the recorded composition does not name — is not built, for the reason Task 11 gives; FR-INS-062's default is served and pre-ticked, so that half is met. FR-INS-039's photographs are out of scope above. Six of the eight capabilities have no nav destination (Task 1). Nothing lets a controller *create* a composition yet; the fixture seeds one.

**Fixtures are typed on purpose.** Every `CapturePosition` / `CaptureContext` literal in a test carries the full shape, so `tsc --noEmit` fails the moment the server adds a field the client has not taken up. That is the point: a partial fixture would let the two drift silently. When a field is added to either interface, expect `make lint` to fail until every fixture names it.

**Type consistency.** `Warning` is defined once in Task 3 and reused by Task 4. `RecordedWarning` (Task 6) is the persisted form and `SubmitWarning` (Task 7) the wire form; the three are deliberately distinct and each conversion is one function. `CaptureConfig` gains `treadGranularityMm` in Task 3 and `CaptureContext` gains `lastOdometerAt` in Task 4 — both are noted in the step that needs them, and both come from the server plan's amended Task 4.

**Known gaps in the server slice, raised there and not here.** Three contract gaps were found while writing this plan and fixed in `2026-08-25-driver-capture-server.md`, not worked around here: `app.reading` had no column for NFR-OBS-007's per-position timing (added in its Task 2); `app.submit_inspection` never implemented the FR-INS-063 observation its own decision block promised (added in its Task 3); and `completeness_pct` defaulted to 100 for a partial submit (now sent by Task 7 here). **The server slice must be re-run through those amendments before this plan executes.**

**The one thing to get right.** Task 7's entry-order test. Everything else fails loudly.
