# ADR-0015: UI substrate

- **Status:** Accepted
- **Date:** 2026-09-21
- **Deciders:** Rourke (engineer); the owner's answer of 10 Sep 2026 (tokens plus CSS with Radix for the hard controls)
- **Related:** ADR-0001 (React + Vite) · ADR-0009 (online-first PWA) · ADR-0010 (provenance) · TYRE-27 (tokens and tenant theming) · TYRE-238 · NFR-USE-001/003/009 · IR-UI-001

## Context

One application serves two audiences (IR-UI-001): a driver on a personal
phone in the sun with gloves on, and a fleet manager at a desk reading money.
The capture flow answers to a three-minute budget (NFR-USE-001) and ships
over a depot connection, so every byte on its route is paid for by a driver.
The manager screens are functional and plain: hand-written CSS on a small
token file, no shared components, no charts, tables that align numbers left.

B7.3 builds the first screen that is a design problem rather than a form: a
dashboard led by a rand figure, with severity, provenance and a tread-band
chart, every one of which must read without colour (NFR-USE-009) and in
direct sun (NFR-USE-003). B7.4 then restyles ten existing screens onto
whatever B7.3 chooses.

Three forces make the choice non-obvious:

- **The tenant owns one colour** (TYRE-27). `deriveBrandTheme` computes
  hover, pressed and on-primary from it so WCAG AA holds for any input. A
  second theming system with its own idea of "primary" would fight that.
- **The capture route must not grow.** A component library or a chart
  library lands in the entry bundle unless every use is code-split, and a
  lazy fetch in front of the driver's flow is the round trip ADR-0009 exists
  to avoid.
- **Colour is a rule, not a style.** `web/CLAUDE.md` makes a hex literal in
  a component a bug; every colour and font is a token consumed through a
  custom property, and the comment checker reads `.css` and `.tsx` lines.
  A utility-class system scatters colour decisions across markup where no
  gate sees them.

The controls that are hard to hand-roll are few: a select that is keyboard
and screen-reader correct on Android and iOS, a dialog that traps focus and
returns it, a popover that positions itself. Everything else on the page is
a heading, a number, a table or a bar.

## Options considered

### Option A: tokens, plain CSS on custom properties, Radix primitives for select, dialog and popover, inline SVG charts

What it is: `tokens.ts` grows into a full scale (type ramp, space, radius,
elevation, semantic roles for severity and provenance, an ordinal tread-band
ramp); components are house-written on those custom properties; the three
hard controls wrap unstyled Radix primitives; charts are inline SVG built
under the `dataviz` method with a table view behind each.

Why it is attractive: nothing new owns colour; the tenant derivation stays
the only theming system; Radix is headless so the tokens style it; the
capture route can keep every Radix import behind a lazy boundary; a chart
that is SVG in the codebase is reviewable text.

**Its real downside:** every component is ours to build, test and keep
accessible. A DataTable with a sticky header, a Select with proper touch
behaviour and a chart with a hover layer are each a day's work that a
library would give for free, and their bugs are ours.

### Option B: a component library (Radix Themes, Mantine, MUI)

What it is: adopt a styled library and theme it to the tenant colour.

Why it is attractive: tables, dialogs, selects, badges and layout arrive
tested and accessible; B7.4's restyle becomes a swap.

**Its real downside:** a second theming system. Each library derives its own
hover, pressed and contrast states from a palette object, which either
duplicates `deriveBrandTheme` or replaces it, and neither keeps TYRE-27's
guarantee that any tenant colour clears AA. The libraries weigh 60 to 300 KB
gzip before tree-shaking and their CSS-in-JS or theme provider sits in the
entry bundle, on the capture route. Their visual identity is theirs.

### Option C: Tailwind (utility classes) with a plugin exposing the tokens

What it is: keep the token file as the Tailwind theme and style in markup.

Why it is attractive: fast to write, no CSS files to keep in step with
components, a large ecosystem of copyable patterns.

**Its real downside:** colour and type decisions move into `className`
strings across every component, where `web/CLAUDE.md`'s "a hex literal in a
component is a bug" cannot be checked and where the tokens rule becomes a
convention. `docs/lessons.md` (2026-09-01) already records that nothing in
the codebase connects a class name to a stylesheet; utilities make that the
whole system.

### Option D: a chart library (Recharts, Chart.js, Nivo)

What it is: draw the tread-band chart and any later chart with a library.

Why it is attractive: tooltips, axes, responsiveness and animation for free.

**Its real downside:** a palette of its own that the `dataviz` colour rules
would have to override, 40 to 120 KB gzip that only one panel needs, and a
component whose rendered SVG is not in the codebase. The dashboard has one
chart; a library for one chart is the wrong trade.

## Decision

We will build the design system on `tokens.ts` and plain CSS on custom
properties, wrap `@radix-ui/react-select` and `@radix-ui/react-dialog` now
and `@radix-ui/react-popover` when a screen first needs one, as the only
third-party UI, and draw charts as inline SVG under the `dataviz` method;
every Radix import and every manager page loads behind a `React.lazy`
boundary so the capture route's JavaScript does not grow, and a build gate
asserts that (TYRE-238).

Light mode only in B7 (spec U15): the token structure is light-first with
dark values absent, not a flat palette.

## Consequences

**Good:** one theming system, the tenant's colour derived once; colour and
type stay checkable in two files; the capture route gets smaller, not
larger, because the manager pages stop shipping with it; a chart is a
reviewable SVG with a table view; B7.4 restyles onto components that exist.

**Bad:** we own the accessibility of every component, and the three Radix
wrappers need jsdom stubs (`hasPointerCapture`, `scrollIntoView`) to test at
all. A fourth hard control (a combobox, a date-range picker) is another
Radix package and another lazy boundary, decided case by case. No dark mode
until a ticket asks for one; the tokens are shaped for it but empty.

**Revisit when:** a screen needs more than three headless primitives; when
the bundle gate cannot hold the capture route flat without contortion; when
a second chart form (time series) is needed and the SVG cost exceeds a
library's; or when a tenant asks for dark mode.

**Amended 2026-09-25 (TYRE-276, U53):** the tenant's one colour now
reaches chrome and filled controls only. Links, quiet buttons and every
focus ring use the fixed `--interactive` token, because `deriveBrandTheme`
guarantees text on the brand, not the brand as text or as a ring: a light
brand falls to 1.6:1 on the surface, and a red one reads as a CRITICAL
severity. `src/theme/brandConfinement.test.ts` keeps the brand out of
page content.
