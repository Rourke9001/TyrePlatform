# ADR-0020: The Tread design system replaces the TYRE-238 kit

- **Status:** Accepted (owner, 21 Oct 2026).
- **Date:** 2026-10-20
- **Deciders:** Rourke (owner decision of 20 Oct 2026)
- **Related:** ADR-0015 (UI substrate; this keeps its substrate and
  supersedes its kit, its light-only rule and its fixed mockups) · ADR-0009
  (client platform and on-device data) · ADR-0010 (provenance) · TYRE-443
  (epic), TYRE-444 (this record), TYRE-445, TYRE-446, TYRE-447, TYRE-449 ·
  BR-VEH-001, FR-VEH-034 (position numbering) · TYRE-272,
  TYRE-240, TYRE-238 · TYRE-26, TYRE-27, TYRE-276 (branding, U53) · TYRE-152,
  TYRE-448 (photos, damage) · the design artifact,
  https://claude.ai/artifact/ENPBvfmt7wqw6naPwxQZ6c

## Context

The owner judged the web app hard to use and hard to follow, and asked on
20 Oct 2026 for the front end to be reworked as a whole, "assume nothing has
been agreed", keeping the per-tenant branding. TYRE-272 had already asked
for a redesign, but bounded it: extend the TYRE-238 system rather than
replace it, and treat the dashboard and exceptions mockups accepted at the
TYRE-238 gate as fixed. The owner's request lifts both bounds.

What makes the choice hard:

- **Two visual systems ship today.** The analytics pages use the `ui/` kit;
  the fleet, admin and driver pages use raw tables, `note-card` and
  `btn-primary`. Four type families (Archivo, Barlow, Barlow Condensed, IBM
  Plex Mono) carry one product. A restyle onto the existing kit keeps the
  kit's gaps: no tyre-position component, no driver shell, no photo control.
- **The two audiences pull apart.** A driver reads 27 positions on a phone
  in sun with gloves in about three minutes (NFR-USE-001, the capture
  target); a manager reads money and work at a desk. Today both get the
  manager's header and a ten-item flat menu, and the driver's diagram and
  the manager's unit plan draw the same rig two different ways with two
  numbering schemes.
- **The tenant owns one colour.** `deriveBrandTheme` makes any tenant colour
  legible (TYRE-27), and U53 keeps it out of links, focus and status
  (TYRE-276). Any new system has to keep both guarantees, or a red brand
  reads as Critical again.
- **The capture route pays for every byte.** Its entry closure is gated at
  139,902 bytes gzip (`web/bundle-budget.json`). New components, a new font
  or a theme switch that lands in the entry chunk is paid by every driver on
  a depot connection, and ADR-0009 forbids putting a lazy fetch in front of
  the capture flow.
- **Unbuilt Musts need a design.** Photo capture (FR-INS-023, 039,
  FR-OFF-008, 017 to 019; TYRE-152) and damage observations (FR-INS-024;
  TYRE-448) have no screens, and the app tells the driver to take a photo it
  cannot take.
- **One person builds it,** with agent help, against a pilot. Whatever is
  chosen is ours to test and keep accessible.

## Options considered

### Option A: restyle the existing screens onto the TYRE-238 kit (TYRE-240 as written)

What it is: keep `tokens.ts`, the four families and the twelve `ui/`
components; move the remaining ten routes onto them one by one; leave the
dashboard and exceptions screens as accepted.

Why it is attractive: the smallest change. The kit is tested, the bundle
gate already holds it, and the accepted mockups need no rework.

**Its real downside:** it keeps what the owner rejected. The kit has no
answer for the driver's side (shell, keypad, tread cells, rig diagram,
photos), so those stay hand-styled; the four families and the light-only
palette stay; the two pictures of a rig stay. It is a restyle of a flow the
owner called hard to follow.

### Option B: Tread, a new token set and component library on ADR-0015's substrate

What it is: the design system in the artifact above.

- **Tokens:**
  - Neutrals, a fixed platform `interactive` (U53) and a tenant brand slot.
  - One status scale (`ok`, `warn`, `critical`) for both tyre condition and
    exception severity.
  - A one-hue `data` ramp for charts.
  - Overlay, spacing, radius, target-size and shadow tokens.
  - Two themes, Daylight and Night shift, with every text pair checked in
    both.
- **Type:** one self-hosted superfamily, Atkinson Hyperlegible Next and
  Mono.
- **Components:** 42 of them, among them a glove keypad, width-wise tread
  cells, a tyre tile, a plan-view axle diagram, photo capture and gallery,
  a damage note, and a shell per audience.

It is built on the same substrate ADR-0015 chose: tokens consumed as CSS
custom properties, plain CSS, Radix behind lazy boundaries for the
manager's hard controls, inline SVG charts.

Why it is attractive: it answers the brief and the gaps together. One
library serves every screen. The driver gets a shell and controls designed
for gloves and glare. Both sides draw a rig the same way, in BR-VEH-001's
plan view with its per-unit position numbers. The brand derivation and U53 carry over unchanged, and
the substrate does too, so no second styling system arrives.

**Its real downside:** it is a rewrite of every screen's styling.

- Every token is renamed, which touches every stylesheet and many tests.
- 42 components are ours to port, test and keep accessible, against twelve
  today.
- A second theme doubles the contrast work and needs a switching rule.
- The font swap moves the capture bundle.
- The accepted dashboard and exceptions mockups, and the TYRE-239 work
  built on them, are redone.
- A theme preference is a new piece of state, kept per device, with a
  settings screen to change it.

### Option C: a styled component library themed with Tread's tokens (Mantine, Radix Themes)

What it is: take Tread's visual direction but build it from a library's
components.

Why it is attractive: tables, menus and dialogs arrive tested; the port is
smaller.

**Its real downside:** the one ADR-0015 already found. A library brings its
own theme engine, which either duplicates `deriveBrandTheme` or replaces
it, and loses TYRE-27's guarantee and U53's confinement. Its runtime sits
in the entry bundle on the capture route. And no library has a tread cell,
a rig diagram or a glove keypad, so the components that matter most are
ours anyway.

## Decision

We will rebuild the web app's tokens, typography and components as the Tread
design system, on the substrate ADR-0015 chose, and retire the TYRE-238 kit,
its light-only rule and its accepted mockups as fixed inputs.

What carries over from ADR-0015, unchanged:

- tokens consumed as CSS custom properties, plain CSS, no utility classes
- Radix only for the manager's hard controls, behind `React.lazy`
- inline SVG charts with a table behind each
- the capture bundle gate, and no lazy boundary in front of `src/capture/`
  or `src/driver/`
- `deriveBrandTheme` and the U53 confinement, with the platform default
  `#14586e`

What this record settles beyond ADR-0015:

- **Themes.** Each person chooses Follow phone, Daylight or Night shift
  on a settings screen (owner, 20 Oct 2026). The choice is a per-device
  preference, kept in local storage rather than on the server, because it
  is about the screen in front of them, not about the tenant. Follow phone
  is the default and reads `prefers-color-scheme`. Daylight is what
  renders before the preference is read and wherever it cannot be.
  `[data-theme]` on the root element carries the result (TYRE-445; the
  screen is TYRE-449).
- **Brand.** The tenant colour reaches chrome only: the app bar band, the
  logo tile, the one primary action per screen, the keypad's go key and the
  active nav marker. It never reaches status, charts, links or focus.
- **Status.** Condition and severity share one scale, so one colour means
  one thing on both sides of the app. Every use carries an icon and a word
  (NFR-USE-009). `ok` and `critical` differ by at least 3:1 in lightness.
- **Type.** Atkinson Hyperlegible Next and Mono only. Fonts stay
  self-hosted, never a CDN (TYRE-446).
- **Shells.** `DriverShell` for actors without `ViewFleet`; `AppShell`,
  with grouped navigation filtered by capability, for the rest. Hiding a
  nav item stays a courtesy (NFR-SEC-006).
- **Rig picture.** One diagram on both the capture and vehicle screens,
  in the frame BR-VEH-001 sets:
  - plan view, nose up, per unit;
  - positions numbered from 1, foremost axle first, then left to right;
  - a dual axle reads left outer, left inner, right inner, right outer.

  Each tile shows that number. The tyre sheet adds the place in words
  ("axle 1, right inner"), so nobody has to learn a code. Rig-level
  numbers stay a computed projection (FR-VEH-034), never a label.
- **Capture select.** Tread's native `Select` serves the capture route,
  because the platform picker suits gloves and keeps Radix out of the
  entry chunk.
- **Existing web rules that Tread's previews do not show stay binding**
  (`web/CLAUDE.md`):
  - `DataTable` stacks on a phone by rendering cards, not by CSS
    `display: block`, which drops table semantics (TYRE-238 comment 12938).
  - A measurement renders through `formatMm` with one decimal.
  - Wire codes become words only in `src/ui/vocabulary.ts`.

The non-negotiable rules (CLAUDE.md), stated because a design system could
erode them:

- **Rule 1, tenancy.** Not touched. Branding stays tenant configuration
  read through `GET /api/org/branding` under RLS. The brand cache stays
  keyed by tenant (ADR-0016).
- **Rule 2, money.** Not touched. Components receive money already
  formatted by `formatMoney` and do no arithmetic.
- **Rule 3, immutability.** Not touched. "Tap a tyre to read or fix it"
  edits the unsent draft on the phone. A submitted reading has no edit
  control anywhere, and a correction stays a compensating event.
- **Rule 4, tread.** `TreadReadings` shows every width-wise reading and
  marks the minimum as governing (CR-011). No component accepts a single
  tread figure as the reading.
- **Rule 5, thresholds.** Every threshold is a prop from tenant
  configuration. `StatusBadge` names a condition and never computes one.
  The constants in the artifact's prototypes are sample data, not
  defaults.
- **Rule 6, timestamps.** They still render through `tenantTime.ts`.
- **Rule 7, offline.** Not changed. `SyncStatus` displays the durable
  outbox's state; there is no sync engine behind it. Photos queue apart
  from readings, as ADR-0009 already says, when TYRE-152 builds them. The
  capture route stays static.

## Consequences

**Good:**

- One library and one type family across every route.
- The driver gets controls sized to NFR-USE-004's glove targets throughout:
  56px for controls, 64px for keypad keys.
- A manager and a driver talk about the same tyre with the same number
  and the same picture, the one BR-VEH-001 already describes.
- Problems are the loudest thing on a screen: an OK tyre is a pale tint,
  an at-limit tyre is the strongest fill.
- Photo and damage capture have a design that adds no taps to a clean
  tyre (the owner's TYRE-152 rule).
- Night shift lifts the "no dark mode until a ticket asks" line ADR-0015
  left.
- The brand guarantees of TYRE-27 and U53 survive intact.

**Bad:**

- The token rename and the component port touch every screen and many
  tests, and two systems coexist until the last route moves (TYRE-445 to
  TYRE-447, then the per-surface slices).
- 42 components are ours to keep accessible.
- The second theme is a second set of contrast pairs to hold on every
  change.
- The dashboard and exceptions screens accepted at the TYRE-238 gate, and
  the TYRE-239 work behind them, are redone. TYRE-240's B7.4 scope has to
  be re-cut.
- The font swap may move the capture bundle either way. The budget only
  ratchets down, so a rise needs `--record` and a reason in the PR.
- Capture today numbers a rig 1 to 27 across its units, a display
  projection drivers have used. Moving to per-unit numbers changes what
  they see, for the driver training OR-TRN-001 bounds at 10 minutes.
- The theme preference is per device. A manager who switches on a laptop
  sees Follow phone on their phone until they switch there too.

**Revisit when:**

- drivers in the field trial (NFR-USE-002) find per-unit numbers slower to
  place than the rig-wide ones;
- people ask for the theme to follow them across devices, which would move
  it to a per-user setting on the server;
- the capture flow measured on a phone is slower than today's;
- the capture bundle cannot stay within budget without a lazy boundary in
  front of capture;
- a tenant asks for its brand inside content, which U53 forbids;
- a third theme, such as high contrast for sunlight, is asked for. The
  token structure takes it, but every pair would need a third check.
