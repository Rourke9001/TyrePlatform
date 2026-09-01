// Turning a refusal into a sentence a person reads. One implementation, so
// the rule about *which* messages may be rendered lives in one place: our own
// validation and conflict messages are safe to show (ADR-0012/ADR-0013), and
// anything else gets the screen's general sentence rather than a wrong
// specific one. The wording stays per-screen — that is content, not logic.

import { ApiError } from "./client";

// Every screen speaks these two: invalid_submission carries a field-level
// message we wrote, and conflict is the generic 409 an unmapped constraint
// arrives as.
export const ALWAYS_SPEAKABLE = ["invalid_submission", "conflict"] as const;

export interface RefusalWording {
  // This screen's own codes, on top of ALWAYS_SPEAKABLE. List only what the
  // screen's endpoints can actually raise: a code that cannot arrive is not
  // documentation, it is a claim the next reader has to disprove.
  speakable: readonly string[];
  forbidden: string;
  fallback: string;
}

export function refusalMessage(error: unknown, wording: RefusalWording): string {
  if (error instanceof ApiError && error.code !== null) {
    const speakable: readonly string[] = [...ALWAYS_SPEAKABLE, ...wording.speakable];
    if (speakable.includes(error.code) && error.message !== "") {
      return error.message;
    }
    if (error.code === "forbidden") {
      return wording.forbidden;
    }
  }
  return wording.fallback;
}
