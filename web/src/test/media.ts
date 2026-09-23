import { vi } from "vitest";

// A MediaQueryList whose answer a test sets. It is a real EventTarget, so a
// hook subscribed to "change" re-renders when change() fires one.
export class TestMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: MediaQueryList["onchange"] = null;

  constructor(
    readonly media: string,
    public matches: boolean,
  ) {
    super();
  }

  // The deprecated listener pair, required by the type; usePhone uses
  // addEventListener.
  addListener = (): void => undefined;
  removeListener = (): void => undefined;

  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

// Every query answers `matches` until the returned function puts back the
// desktop stub from setup.ts. One answer for every query is enough while
// usePhone is the only caller.
export function forceMatchMedia(matches: boolean): () => void {
  const spy = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => new TestMediaQueryList(query, matches));
  return () => spy.mockRestore();
}
