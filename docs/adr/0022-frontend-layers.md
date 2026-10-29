# ADR-0022: The web app is held to four layers: data, transform, domain, presentation

- **Status:** Accepted (owner, 26 Oct 2026, with U156)
- **Date:** 2026-10-26
- **Deciders:** Rourke (owner), with the TYRE-443 rebuild
- **Related:** ADR-0009 (outbox), ADR-0015 and ADR-0020 (substrate and
  Tread), ADR-0016 (sign-in) · TYRE-443 · the design spec
  `docs/superpowers/specs/2026-10-26-tread-frontend-design.md`

## Context

The owner asked for the Tread rebuild to follow SOLID principles and a clean
split of domain, data and transform code. Today the split is by feature
folder only. A screen such as `dashboard/Dashboard.tsx` fetches, reshapes
wire data and renders in one file, and `ui/` components and screens import
across each other freely. Nothing stops a component from calling the API or
a screen from formatting money its own way.

What makes the choice non-obvious:

- **The business rules are not here.** Valuation, exceptions and
  thresholds live in SQL with one implementation (CLAUDE.md, Where logic
  belongs). A frontend "domain layer" in the usual sense, holding entities
  and rules, would be a second implementation and the drift the three-way
  agreement exists to catch. The one rule the frontend holds on purpose is
  `capture/warnings.ts`, the independent capture-side check.
- **The capture entry pays for every import** (ADR-0009, the bundle gate).
  A layer that pulls a shared module into the entry costs every driver.
- **About 200 files and their tests exist.** Moving them all to new folders
  in one change buries the redesign in renames.

## Options considered

### Option A: feature folders only, as today

Each feature owns its fetching, shaping and rendering.

Why it is attractive: no change, and a feature reads top to bottom in one
place. **Its real downside:** nothing enforces where formatting, wire
reshaping or fetching happens, so each screen solves them again, and the
Tread library could start importing app code.

### Option B: full clean architecture (entities, use cases, repository interfaces, injected adapters)

Why it is attractive: the textbook shape, testable at every seam. **Its
real downside:** in a thin client whose rules live in SQL, the use-case and
repository layers carry no logic, only indirection, and they sit between
Tanstack Query and the screens that need its cache and loading states. The
entity layer invites the second implementation of tyre rules that CLAUDE.md
forbids.

### Option C: four thin layers with an import rule each, enforced by lint

Data, transform, domain and presentation, mapped onto the folders that
exist, with eslint refusing an import that crosses a layer the wrong way.

Why it is attractive: it gives the separation the owner asked for, keeps
Tanstack Query as the data seam, and holds no logic the database owns. The
rule is checked by `make lint`, not by convention. **Its real downside:**
feature folders still mix a screen's data hook, view model and components,
so the layer is read from the file's role, not only its folder; and the
older screens do not meet it until they are ported.

## Decision

We will hold the web app to four layers, each with an import rule enforced
by eslint `no-restricted-imports` and `no-restricted-globals`:

- **Data** is `src/api/` (the client, wire types and fetchers), each
  feature's `*.data.ts` (the query hooks its screens read through, kept
  beside them so two features never edit one file), and, for capture,
  `capture/outbox.ts`, `capture/draft.ts` and their hooks. Only `src/api/`
  calls `fetch`, and only the outbox and draft open Dexie.
- **Transform** is `src/format/` and each feature's `*.view.ts`: pure
  functions from wire shapes to what a screen shows, tested without React.
  A transform imports from domain and other transforms only.
- **Domain** is `src/domain/`: types and vocabulary, with
  `ui/vocabulary.ts` moved into it. It holds no tyre business rule. It
  imports nothing from the other layers.
- **Presentation** is `src/ui/` (Tread's components) and the feature
  folders' screens, with the hooks the screens call: `src/time/` and
  `src/units/` are React hooks over the signed-in actor, not transforms.
  `src/ui/` imports only `src/theme/`, `src/format/` and
  domain, never `api/`, `auth/`, `units/`, `time/` (both read the actor)
  or a feature. A screen reads data through a
  hook and renders a view model; it never calls `fetch`.

SOLID is applied the way React supports it: one job per component and per
module (single responsibility); variants as props and composition, not
forks (open and closed); narrow props, so a component takes the view model
it renders and not a wire object (interface segregation); screens depend on
hooks and view models, not on the client (dependency inversion).

## Consequences

**Good:**

- Formatting, wire reshaping and fetching each have one home, and lint says
  where.
- Tread's library stays reusable: it cannot reach app state.
- View models are tested as plain functions, so a screen test checks
  rendering, not arithmetic.
- No tyre rule gains a second implementation.

**Bad:**

- Until every screen is ported, older screens break the rule. The lint
  rule is scoped to `src/ui/`, `src/domain/`, transforms and ported
  screens, and widens as screens port.
- A view model per screen is more files than one component that does
  everything.
- `capture/` keeps data-layer files in a feature folder, because the
  entry must carry them and a move buys nothing.

**Revisit when:**

- a frontend rule other than `warnings.ts` is proposed, which would mean
  the domain layer is starting to hold logic the database owns;
- the lint scope still excludes screens after the last Tread port.
