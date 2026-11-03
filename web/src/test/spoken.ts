import { expect } from "vitest";

// CR-010/OR-LEG-001 keeps compliance language away from a driver, anywhere on
// the screen. "roadworthy" is a legitimate internal band name (warnings.ts),
// pinned here so a per-file copy cannot forget it.
const COMPLIANCE = ["legal", "roadworth", "statutory", "minimum"];

// IR-UI-014, FR-INS-029a (D-A): capture numbers its tread fields left to right
// as seen from above and never names them Outer, Centre or Inner. The ban
// binds those labels only, so a place in the sheet header such as "axle 1,
// right inner" is allowed (U147, TYRE-207 B10).
const POSITION = ["inner", "outer", "centre"];

// The tread fields and what labels them: TreadReadings' cells, the sheet's
// frame over them, and TreadGlyph wherever it is drawn.
const TREAD_LABELS = ".tr-tread, .cap-frame, .cap-glyph";

// Accessible names are driver-facing too: the entry sheet's field labels reach
// a driver only as aria-labels and never as a text node, so a text-only sweep
// misses the strings most likely to carry a banned word. The root's own name
// counts, since TreadGlyph's sits on the element TREAD_LABELS selects.
export function spokenText(root: Element): string {
  return [
    root.textContent ?? "",
    ...[root, ...Array.from(root.querySelectorAll("[aria-label]"))].map(
      (el) => el.getAttribute("aria-label") ?? "",
    ),
  ]
    .join(" ")
    .toLowerCase();
}

// Driver screens only. OR-LEG-002 requires the manager screens' tread reports
// to carry a notice that statutory roadworthiness rests with the operator,
// which COMPLIANCE would forbid (TYRE-207).
export function expectNothingForbiddenSpoken(container: HTMLElement, present: RegExp): void {
  const spoken = spokenText(container);
  // `present` is the positive half, and it is not optional: without it every
  // assertion below passes on an empty container, which is exactly what a
  // screen that never rendered looks like.
  expect(spoken).toMatch(present);
  for (const word of COMPLIANCE) {
    expect(spoken).not.toContain(word);
  }
  const treadLabels = Array.from(container.querySelectorAll(TREAD_LABELS))
    .map(spokenText)
    .join(" ");
  for (const word of POSITION) {
    expect(treadLabels).not.toContain(word);
  }
}
