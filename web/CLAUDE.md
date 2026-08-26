# web/

React + Vite. **One application, one deployment** (IR-UI-001): a
mobile-optimised capture interface and a desktop-optimised management
interface, reached by role-appropriate routes within it. They share components
but not priorities — see the three-minute constraint below.

## The capture app answers to one number

> A trained driver completes a ten-position vehicle in a median of **3 minutes**
> (NFR-USE-001), and a 26-position combination in **7 minutes** (NFR-USE-001a).

Three tread readings per position means a superlink is **108 numeric entries**.
Every interaction decision follows from that arithmetic:

- Thumb keypad, not the OS keyboard. Auto-advance between boxes.
- No modals, no confirmation steps, no navigation between positions.
- Large hit targets — this is used with **work gloves on**, in **direct
  sunlight** (NFR-USE-003, NFR-USE-004). High contrast is a functional
  requirement, not a style choice.
- Never ask for the same value twice (NFR-USE-006).
- Preserve input across backgrounding (NFR-USE-011) — a driver *will* get a
  phone call mid-inspection.
- Success must be shown explicitly (NFR-USE-010). Drivers cannot be expected to
  infer success from the absence of an error.

**Before adding anything to the capture flow, count the taps it costs.** A
feature that improves the dashboard and adds three seconds per position adds
over a minute to a superlink, and the POC fails on adoption.

`docs/prototypes/driver_capture_prototype.html` is the reference for the
interaction model — a gitignored working mirror. The authority is Confluence:
*Driver Capture Prototype v1.0* (pageId 13238274, under *UI Prototypes v1.0*
in the Specification tree).

## The network (ADR-0009)

Online-first with a durable submit outbox — not an offline sync engine.

- Reads (vehicle lists, configuration) are fetched live; nothing replicates
  the register to the phone.
- The one in-progress inspection is held durably on-device until the server
  acknowledges it, with a visible outbox indicator, an explicit "Sync now" and
  a stale-queue warning after ~2 days. Never depend on background sync — iOS
  Safari has no Background Sync API and evicts storage aggressively.
- Each inspection carries a client-generated UUID; the server treats
  submission as idempotent, so replaying the outbox is safe.
- Photos queue separately from readings.

## Browser tests (e2e/)

`e2e/` holds Playwright specs; vitest never runs them (excluded in
vite.config.ts) and they never mock — they drive the real dev stack in
headless browsers. Three projects: `chromium` at a desktop viewport,
`android` (Pixel 7) and `ios` (iPhone 14, WebKit). The capture app is judged
at phone dimensions, so `reach.spec.ts` runs on all three and
`capture.spec.ts` on `android` alone — FR-INS-038's duplicate window is
tenant state in one shared database, and the same vehicle submitted from a
second project is refused by the first.

Run with `make e2e`, which reseeds and requires `make api-run` in another
terminal; CI's "Browser smoke" job builds that stack itself on every PR. The
reseed is not optional: `capture.spec.ts` submits, so a second run against the
same seed is refused at the first spec. Identity is the dev actor headers, so
specs run against `vite dev`, never a production build (playwright.config.ts
says why). Assert on roles and visible text, not CSS — with one deliberate
exception: a requirement id may be reached through a `data-` attribute
(`data-position-id`, `data-warning-code`), because CR-010 keeps those ids out
of driver-facing wording and a spec keyed on the friendly name would fail on
the next copy edit.

## Conventions

- Function components and hooks. `strict: true`. No `any`.
- Tanstack Query for server state; `useState`/`useReducer` for local. No Redux.
- Money arrives from the API as a **string**. Keep it a string. Format for
  display, never `Number()` it — JavaScript has no decimal type and this is the
  one place that matters.
- Do not convey information by colour alone (NFR-USE-009). Sort identifiers in
  natural order, not lexicographic (NFR-USE-012) — `POS2` before `POS10`.
- Colours and type live in `src/theme/tokens.ts` only, consumed through CSS
  custom properties (TYRE-27). A hex or font literal in a component is a bug.
  Tread band colours are fixed and keyed to band *names*; the mm thresholds
  that assign a band are tenant configuration and never reach this codebase
  (rule 5). Fonts are self-hosted @fontsource — no CDN: the capture app must
  render on a flaky depot connection, and a font fetch is a third-party
  dependency the driver's flow must never wait on (ADR-0009).
- Tenant branding (display name, primary colour, nullable logo) is tenant
  configuration in the database (`app.configuration` key `branding`), served
  by `GET /api/org/branding` and applied by `src/theme/ThemeProvider.tsx`,
  which derives hover/pressed shades and a contrast-safe on-primary from the
  one colour a tenant picks (TYRE-26/27).
