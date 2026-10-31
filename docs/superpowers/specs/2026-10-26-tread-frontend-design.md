# Design: the web app rebuilt on Tread (TYRE-443)

- **Date:** 2026-10-26
- **Tickets:** epic TYRE-443. This branch carries TYRE-445 (colour and
  themes), TYRE-446 (type), TYRE-447 (the component library and gallery)
  and the restyle half of TYRE-240. TYRE-152, TYRE-448 and TYRE-285 keep
  their behaviour; their components are built here and wired there.
- **Decisions it rests on:**
  - ADR-0015 (UI substrate) and ADR-0020 (Tread), as amended by owner
    ruling U156 below.
  - ADR-0022 (frontend layers), written with this spec.
  - U145 (capture rulings), U53 (brand confinement), U143 (a driver starts
    from a task), ADR-0009 (online-first with an outbox), ADR-0016
    (sign-in), ADR-0019 (runtime config and CSP).
- **Source:** the Tread artifact,
  https://claude.ai/artifact/ENPBvfmt7wqw6naPwxQZ6c: `project/tokens.json`,
  `project/components/src/*`, `project/fonts/*`, `project/sections/*` and
  the screen compositions under `project/build/src/screens/`.
- **Requirements:** IR-UI-001, IR-UI-014, NFR-USE-003, NFR-USE-004,
  NFR-USE-007, NFR-USE-009, NFR-USE-010, NFR-USE-012, FR-INS-029a,
  FR-INS-060, FR-VEH-034, BR-VEH-001, FR-DSH-001, FR-DSH-012, FR-DSH-013,
  Appendix I.

## Why this exists

The owner judged the web app hard to use and hard to follow (ADR-0020,
Context) and wants shareholders to see the finished frontend at a meeting on
Wednesday 28 Oct 2026, where the SRS functional requirements are discussed.
The demo runs from the owner's laptop against the local stack. Staging is
welcome but not required.

## Owner ruling U156 (26 Oct 2026)

All existing frontend work is outdated by the Tread artifact. The web app's
look and structure are rebuilt on Tread now, on every route, rather than in
ADR-0020's sequence. This supersedes ADR-0020's **Sequence** paragraph only:
the older screens no longer wait for the pilot, capture no longer waits for
one later slice with TYRE-152, 448 and 285, and the restyle no longer waits
for the logic fixes. Everything else in ADR-0020's Decision stands,
including the capture rulings, the navigation rule and the non-negotiable
rules. Recorded on TYRE-443 and under ADR-0020's Status.

## Goals

1. Tread's tokens in both themes (Daylight, Night shift), its type, and all
   42 components, each with tests, shown in the `/dev/design` gallery in
   both themes. `BrandProvider`'s job stays with `ThemeProvider`. The
   components the demo path uses come first; the gallery-only set (photo
   capture and gallery, damage note, timeline, progress, choice chips,
   skeleton) comes last and is the first cut if the build runs late.
2. The demo path recomposed on Tread to the artifact's screens (tier 1
   below), with today's behaviour unchanged.
3. Every other route on Tread's tokens, type and components where a
   component is a drop-in, keeping its layout (tier 2 below).
4. The frontend held to ADR-0022's four layers, enforced by eslint.
5. `make check` green and the capture bundle gate green, with the budget
   re-recorded once, with a reason.

## Non-goals

- No change to what any screen does: no new endpoint, no new data, no new
  step, no changed refusal. Each screen is a restyle of today's behaviour.
- No change of wording. Existing copy stays, so the vitest and e2e
  assertions on roles and visible text keep holding. Tread's content rules
  (badge words, state words, greetings) are a follow-on with its own ticket.
- No photo or damage step in the live capture flow. There is no backend for
  it (TYRE-152, TYRE-448), and the app would again ask for a photo it cannot
  take. `PhotoCapture`, `PhotoGallery` and `DamageNote` are built and shown
  in the gallery only.
- No settings screen for the appearance preference (TYRE-449, after the
  pilot).
- No navigation change beyond grouping (ADR-0020, Navigation).

## Anti-goals

The redesign has failed, even if it looks right, if any of these is true:

- A tenant colour reaches status, a chart, a link or focus (U53).
- A threshold, band, cap or target from the artifact's sample data appears
  as a constant (rule 5).
- Capture's entry chunk carries a manager screen's components (tables,
  charts, tabs, the photo set, the old kit, Radix), or a module under
  `src/capture/` or `src/driver/` loads lazily (ADR-0009). Both shells are
  static on purpose: a lazy shell would sit in front of capture for a
  manager who captures, and outside the route error boundary.
- The outbox's state, "Sync now" or the stale-queue warning disappears
  from capture (ADR-0009, NFR-USE-010).
- A test is weakened to pass. A test that only moves (a click on a tab
  before an assertion, a renamed token) says why in its commit.

## What does not port from the artifact

The artifact was drawn before U145. ADR-0020's Decision is the later
authority, and where they differ the ADR wins. No lane ports these:

| The artifact | What ships instead | Why |
|---|---|---|
| Tread cells named Outer, Centre, Inner | Cells numbered left to right as seen from above; manager screens may name them | IR-UI-014, FR-INS-029a, U145 |
| A decimal key "when the step needs it" | No decimal key. Today's half key stays for a tenant set to 0.5 mm, in the delete key's slot | U145, `capture/entry.ts` |
| Exceptions with severity tabs, a search and a row side sheet; the overview's "Find a vehicle or tyre" search | Today's Severity and Rule selects, "Include replaced" and the table, restyled | No new step (non-goals) |
| Hard-coded "mm" and "kPa" | Unit words from `useUnitLabels()` | FR-CFG-021 |
| Today: "any other vehicle is one search away" | No new vehicle search; today's DriverHome behaviour, restyled | U143, TYRE-319 |
| Capture tiles show per-unit numbers only | Capture tiles show the rig-wide number; the per-unit place in words (unit, axle, side) is in each tile's accessible name and the tyre sheet's header, since a dual tile on a phone has no room for it | FR-INS-060, FR-VEH-034, Appendix I |
| "Needs action", rigs and fitments folded into the vehicle page | Exceptions keeps its name; the rigs and fitments pages stay; nav is grouped | ADR-0020, Navigation |
| "4 mm spread", "35 mm cap", "target 800", sample kPa | Props fed from tenant configuration, or absent | Rule 5 |
| `formatRand`, "5 mm" | `formatMoney` with `useCurrency`; `formatMm` with one decimal on manager screens; capture keeps today's strings | Rule 2, `web/CLAUDE.md` |
| Bare `<a href>` links | Router links | `docs/implementation-order.md`, Tread item 4 |
| Sheet and Dialog without a focus trap; Tabs without a tab panel | A focus trap with Escape and focus return; tabs wired to panels | Same, and TYRE-275 |
| Missing tread age | Tread age shown where today's screen shows it (`format/treadAge.ts`) | Same |
| A modal bottom sheet over the rig on capture | A non-modal sheet: the rig stays reachable | `web/CLAUDE.md`, U145 |

## Architecture

ADR-0022 holds the decision. In short, four layers with an import rule for
each:

- **Data** (`src/api/` and each feature's `*.data.ts`): the HTTP client,
  wire types and fetchers, and the query hooks screens read through. The capture outbox and draft stay in
  `src/capture/` (they are the capture feature's data, and the entry needs
  them) but follow the same rule: nothing above them calls `fetch` or Dexie.
- **Transform** (`src/format/`, `src/time/`, each feature's `*.view.ts`):
  pure functions from wire shapes to what a screen shows, unit tested
  without React.
- **Domain** (`src/domain/`): types and vocabulary. `ui/vocabulary.ts` moves
  here. No tyre business rule lives in it: those live in SQL. The one named
  exception is `capture/warnings.ts`, the independent capture-side check
  behind the three-way agreement (CLAUDE.md, Testing).
- **Presentation**: `src/ui/` holds Tread's components, which import nothing
  from `api/`, `auth/` or any feature. Feature folders (`capture/`,
  `driver/`, `dashboard/`, `fleet/`, `admin/`, `settings/`, `auth/`,
  `shell/`) compose screens from hooks, view models and `ui/`.

Rebuilt screens follow the structure now. Tier 2 screens migrate as they
are ported. Files move only where a layer requires it; nothing is moved for
tidiness.

## Tokens and themes (TYRE-445)

- `src/theme/tokens.ts` stays the one source, with Tread's names and values
  from `tokens.json`: neutrals, the fixed `interactive` set, the brand slot,
  the one status scale (`ok`, `warn`, `critical` with their `on-` and
  `-text` pairs, the soft grounds, `unmeasured`), `data-1` to `data-5`,
  overlays, shadows, spacing (`space-1` to `space-12`, so `space-5` is
  20px), radius and size. Each colour has a Daylight and a Night shift
  value.
- One stylesheet, generated from `tokens.ts` and installed by `main.tsx`
  before boot (the CSP allows an inline style, not an inline script),
  carries the theme values under `:root, [data-theme="light"]` and
  `[data-theme="dark"]`. Only the four brand tokens are set on the root
  element, by `ThemeProvider` from `deriveBrandTheme`.
- `deriveBrandTheme` keeps its rule. Its outputs for a set of tenant colours
  are pinned in `derive.test.ts` before the swap, and any change after it is
  explained.
- `statusColor` and `severityColor` give way to the status scale;
  `treadBandRamp` and `provenanceColor` to the `data` ramp.
  `treadBandStep` and `bandFill.ts` keep their interpolation above five
  bands (U56).
- The appearance preference is `system` (the default), `light` or `dark`,
  per device in local storage, read by a hook that follows
  `prefers-color-scheme` live while on `system`. The result sits on the
  root's `data-theme`. Daylight renders before the preference is read and
  wherever storage throws. The read runs in the boot path before the first
  render, never as an inline script, which the CSP refuses (ADR-0019).
- For the demo, the switch is the laptop's own appearance setting, and a
  three-way toggle in the dev-only `DevBar`. No production control ships
  before TYRE-449.
- Checks, extending `tokens.test.ts` and `brandConfinement.test.ts`: every
  text pair the tokens name, in both themes (7:1 for `ink`, 4.5:1 for
  other text, 3:1 for control borders, focus and marks); `ok` against
  `critical` at 3:1 or more; brand tokens set only by `ThemeProvider`;
  the preference cases above. A gate refuses a hex colour literal outside
  `tokens.ts`, and is shown red on a planted literal first.

During the build, the old token names may be aliased to Tread values so
tier 2 screens change colour on the first day. Every alias is gone, and
every stylesheet uses Tread's names, before the PR opens.

## Type (TYRE-446)

Atkinson Hyperlegible Next (400, 500, 700, 800) and Atkinson Hyperlegible
Mono (400, 700), from the artifact's six woff2 files (70 KB together, which
is 446's target), self-hosted beside `fonts.ts`, with the OFL licence file.
The four `@fontsource` packages leave `package.json`. The type scale is
Tread's: `hero`, `display`, `title-1` to `title-3`, `eyebrow`, `body-lg`,
`body`, `body-strong`, `small`, `caption`, and the mono `readout`,
`reading`, `data` and `code`. Readings, registrations and codes are mono.
Drivers read `body-lg`, managers `body`, and nothing goes below `caption`.

## Components (TYRE-447)

The 42 components in the artifact's `components/src/index.ts` land in
`src/ui/`, one file per component with its test, ported to house style:
function components, `strict`, no `any`, comments to `docs/comments.md`
with requirement IDs, every colour and size through a token.

- Where a Tread component shares a name with today's kit (`Button`,
  `DataTable`, `Dialog`, `EmptyState`, `PageHeader`, `Select`,
  `SeverityBadge`, `BandChart`), the old one moves to `src/ui/legacy/` for
  as long as a tier 2 screen still imports it, and is deleted when the last
  one stops.
- `DataTable` renders one card per row below `breakpoint.phone`, chosen by
  `usePhone()`, never by CSS `display: block` (TYRE-238 comment 12938).
- `TreadReadings` shows every width-wise reading and marks the minimum as
  governing (CR-011). No component accepts one tread figure as the reading.
- `StatusBadge` names a condition it is given and never computes one
  (rule 5). Its label comes from the caller, so capture keeps its words.
- `AxleDiagram` and `TyreTile` draw plan view, nose up (BR-VEH-001). The
  tile's label is a prop: capture passes the rig-wide number, and its
  accessible name and the sheet header add place words built from wire
  fields only (unit, axle, side); the vehicle screen passes the position
  `code`, the BR-VEH-001 per-unit number. Inner and outer need an API
  field, which is ticketed; the frontend does not derive them.
- The vehicle screen shows "Last tread" as today: the unit wire carries one
  governing figure, so `TreadReadings` is not used there (rule 4), and its
  tiles carry no condition, because the wire carries none.
- `Sheet`, `Dialog` and `Tabs` get what the artifact lacks: a focus trap,
  Escape, focus return, and tab panels.
- Manager pages may keep Radix behind `React.lazy` (ADR-0015). Capture uses
  Tread's native `Select`.
- `tread.css` splits by route: the tokens, base and the seven capture
  components' rules ride the entry; every other component's rules load with
  the routes that use them.

## Screens

**Tier 1, recomposed to the artifact's screens** (the demo path):

*Amended by owner ruling U159 (31 Oct 2026, TYRE-240), from the review of
PR #153. `DriverShell` keeps the old shell's one link for a driver, "My
inspections", in a row under its bar on every page but `/my`. Dropping it
was a navigation change, which the non-goal above rules out.*

- Both shells: `DriverShell` for actors without `ViewFleet`, `AppShell` with
  today's nav items grouped (`shell/navigation.ts`) and filtered by
  capability. Hiding an item stays a courtesy (NFR-SEC-006). The outbox
  lines keep their structure and words, restyled; the `SyncStatus` chip is
  built and shown in the gallery, and wiring it is a follow-on.
- Sign-in and access screens (`auth/`).
- `/my`, the driver's Today (`driver/DriverHome`).
- `/capture/:vehicleId`: start, the rig, the tyre sheet, review and done
  (`capture/`).
- `/`, the overview (`dashboard/Dashboard`), `/exceptions` and `/at-risk`.
- `/fleet/units/:unitId`, the vehicle (`fleet/unit/`). Its stacked sections
  may move into tabs; a test that has to click a tab first says so.
- `/fleet/tyres` and `/fleet/tyres/new`.

**Tier 2, on Tread's tokens, type and drop-in components, layout kept:**
`/fleet`, `/fleet/rigs`, `/fleet/fitments`, `/fleet/tyres/receipts`,
`/fleet/tyres/retreads`, `/settings`, `/admin/units/new`,
`/admin/users/new`, `ConfigFailure`, the route error boundary and not found.
Each moves to tier 1 when there is time, in the order listed.

## The capture route

- Capture imports each component it renders by its own file path. No file
  under `src/capture/` or `src/driver/` imports a barrel of `src/ui/`.
- The entry budget in `web/bundle-budget.json` (140,835 gzip bytes,
  recorded 26 Oct 2026) only ratchets down. The branch re-records it once,
  in its own commit, naming what grew: Tread's capture components and the
  fonts. The entry's CSS and fonts are measured alongside its JavaScript
  (TYRE-281's half, folded into this work), shown red before green.
- The keypad, cells, tiles and sheet hold NFR-USE-004's floor: 56px
  controls, 64px keys.

## Demo data

Manager screens browse BAC Transport's seeded fixture, which carries
Appendix J's 19 exceptions. Browsing is allowed; typing into BAC is not.
The capture demo types into Sandbox Fleet, which has no tyres on purpose,
so a controller sets it up through the app before the meeting: add a unit,
receive and fit tyres, schedule an inspection for the demo driver. Nothing
of it is committed. `make db-reset` runs before the demo, because `make e2e`
writes into BAC. The fixture is specification input, so it is shown as
sample data and never as findings about a real fleet.

## Testing and gates

- Each component: roles and names, keyboard behaviour (segmented arrows,
  sheet and dialog Escape and focus return, tab arrows), `DataTable` cards
  below 640px, `TreadReadings` marking the minimum, `AxleDiagram` order.
- Each restyled screen: its existing tests pass unchanged except where a
  test only moves, as above.
- `make check` green, `npm run bundle:check` green, `make e2e` green at the
  end of each wave (`dashboard.spec.ts` and `capture.spec.ts` are the nets
  for the two demo paths), `web-design-guidelines` and impeccable's
  detector over the changed UI, with every finding fixed or argued.

## Delivery

One branch, `TYRE-443-tread-frontend`, with commits keyed per ticket
(TYRE-445, 446, 447, 240), so stacked PRs can be cut by commit range after
the meeting: the foundation (445 and 446), the components and gallery
(447), then the screens (240 and 447b). Each PR gets stage 5.
`docs/implementation-order.md` moves the Tread rework to now on this
branch.

## Left to the builder

- How each tier 1 screen is composed from the artifact's screen, within
  the rulings above.
- The old-to-new token map and how the bridge is retired.
- Which tier 2 screens reach tier 1 in time.
- How the CSS split is measured, provided it is shown red first.
