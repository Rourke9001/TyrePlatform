import { expect } from "vitest";

// One list: CR-010/OR-LEG-001 keeps compliance language away from a driver,
// and FR-INS-029a (D-A) keeps the prototype's Outer/Centre/Inner names away
// too. "roadworthy" is a legitimate internal band name (warnings.ts), pinned
// here so a per-file copy cannot forget it.
const BANNED = ["legal", "roadworth", "statutory", "minimum", "inner", "outer", "centre"];

// Accessible names are driver-facing too: the entry sheet's field labels reach
// a driver only as aria-labels and never as a text node, so a text-only sweep
// misses the strings most likely to carry a banned word.
export function spokenText(container: HTMLElement): string {
  return [
    container.textContent ?? "",
    ...Array.from(container.querySelectorAll("[aria-label]")).map(
      (el) => el.getAttribute("aria-label") ?? "",
    ),
  ]
    .join(" ")
    .toLowerCase();
}

// `present` is the positive half, and it is not optional: without it every
// assertion below passes on an empty container, which is exactly what a screen
// that never rendered looks like.
export function expectNothingForbiddenSpoken(container: HTMLElement, present: RegExp): void {
  const spoken = spokenText(container);
  expect(spoken).toMatch(present);
  for (const word of BANNED) {
    expect(spoken).not.toContain(word);
  }
}
