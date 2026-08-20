# web/

React + Vite. Two applications: the driver capture PWA and the manager
dashboard. They share components but not priorities.

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

`docs/prototypes/driver_capture_prototype.html` (untracked, in Confluence) is
the reference for the interaction model.

## Offline

- Dexie over IndexedDB. Write locally first, always. The network is never on
  the critical path.
- Each inspection carries a client-generated UUID; the server treats sync as
  idempotent, so replaying is safe.
- Photos queue separately from readings.
- iOS Safari has no Background Sync API and evicts storage more aggressively
  than Android. TYRE-14 establishes which the pilot drivers actually use.

## Conventions

- Function components and hooks. `strict: true`. No `any`.
- Tanstack Query for server state; `useState`/`useReducer` for local. No Redux.
- Money arrives from the API as a **string**. Keep it a string. Format for
  display, never `Number()` it — JavaScript has no decimal type and this is the
  one place that matters.
- Do not convey information by colour alone (NFR-USE-009). Sort identifiers in
  natural order, not lexicographic (NFR-USE-012) — `POS2` before `POS10`.
