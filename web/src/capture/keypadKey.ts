import type { KeypadKey } from "../ui/Keypad";
import type { EntryKey } from "./entry";

// Tread's keypad names its keys; entry.ts reads EntryKey, in which go is
// next.
export function entryKey(key: KeypadKey): EntryKey {
  if (key === "go") return { type: "next" };
  if (key === "delete") return { type: "delete" };
  if (key === "half") return { type: "half" };
  return { type: "digit", digit: key };
}
