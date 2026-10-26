import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_KEY,
  readAppearance,
  resolveTheme,
  startAppearance,
  writeAppearance,
} from "./appearance";
import { TestMediaQueryList } from "../test/media";

// The OS's colour-scheme answer, kept so a test can change it live.
function osPrefers(dark: boolean): TestMediaQueryList {
  const list = new TestMediaQueryList("(prefers-color-scheme: dark)", dark);
  vi.spyOn(window, "matchMedia").mockReturnValue(list);
  return list;
}

function rootTheme(): string | null {
  return document.documentElement.getAttribute("data-theme");
}

let stop: () => void = () => undefined;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  stop();
  stop = () => undefined;
  vi.restoreAllMocks();
});

describe("the appearance preference", () => {
  it("defaults to system", () => {
    expect(readAppearance()).toBe("system");
    window.localStorage.setItem(APPEARANCE_KEY, "sepia");
    expect(readAppearance()).toBe("system");
  });

  it("system follows prefers-color-scheme", () => {
    osPrefers(true);
    stop = startAppearance();
    expect(rootTheme()).toBe("dark");
    stop();

    osPrefers(false);
    stop = startAppearance();
    expect(rootTheme()).toBe("light");
  });

  it("system tracks a live change", () => {
    const os = osPrefers(false);
    stop = startAppearance();
    expect(rootTheme()).toBe("light");
    os.change(true);
    expect(rootTheme()).toBe("dark");
    os.change(false);
    expect(rootTheme()).toBe("light");
  });

  it("light and dark ignore the OS", () => {
    writeAppearance("light");
    const os = osPrefers(true);
    stop = startAppearance();
    expect(rootTheme()).toBe("light");
    os.change(false);
    os.change(true);
    expect(rootTheme()).toBe("light");
    stop();

    writeAppearance("dark");
    const os2 = osPrefers(false);
    stop = startAppearance();
    expect(rootTheme()).toBe("dark");
    os2.change(false);
    expect(rootTheme()).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  // Daylight wherever storage throws (a private window, blocked site data),
  // and the app still starts.
  it("falls back to light when localStorage throws, even under a dark OS", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readAppearance()).toBeNull();
    expect(resolveTheme(null, true)).toBe("light");
    osPrefers(true);
    expect(() => {
      stop = startAppearance();
    }).not.toThrow();
    expect(rootTheme()).toBe("light");
  });

  it("writeAppearance swallows a throwing store", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => writeAppearance("dark")).not.toThrow();
  });
});
