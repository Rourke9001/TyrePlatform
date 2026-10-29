import { vi } from "vitest";

// jsdom has no ResizeObserver and lays nothing out. Every element measures
// `height` tall, and resize() calls every observer made so far, as a layout
// pass would. restore() puts both back.
export function stubResize(height: number): { resize: () => void; restore: () => void } {
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(() => callback([], this as unknown as ResizeObserver));
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ height } as DOMRect);
  return {
    resize: () => {
      for (const fire of observers) fire();
    },
    restore: () => {
      vi.unstubAllGlobals();
      rect.mockRestore();
    },
  };
}
