import type { Draft } from "./draft";
import { absentCells, capturedCells } from "./payload";

// TYRE-146: markSpareAbsent is an observation, not a reading, and
// clearDraft discards it too. A draft holding only that mark is not
// empty.
export function lostWords(captured: number, absent: number): string {
  if (captured === 0 && absent === 0) return "No positions captured yet.";
  const readings = captured > 0 ? `${captured} captured position${captured === 1 ? "" : "s"}` : "";
  const spares = absent > 0 ? `${absent} "No spare" mark${absent === 1 ? "" : "s"}` : "";
  const parts = [readings, spares].filter(Boolean);
  return `${parts.join(" and ")} will be lost.`;
}

// TYRE-333: the draft is the suspect on the error screen, and counting a
// shape that broke the page can throw, which must not break the screen that
// offers the way out.
export function draftLostWords(draft: Draft): string {
  try {
    return lostWords(capturedCells(draft).size, absentCells(draft).size);
  } catch {
    return "Everything entered for it will be lost.";
  }
}
