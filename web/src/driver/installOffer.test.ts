import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TestMediaQueryList } from "../test/media";
import {
  INSTALL_HINT_KEY,
  deviceOf,
  dismissInstallHint,
  installForm,
  promptInstall,
  readHintDismissed,
  readInstallOffer,
  startInstallOffer,
  type InstallDevice,
} from "./installOffer";

const IPHONE: InstallDevice = { standalone: false, maxTouchPoints: 5, displayStandalone: false };
const ANDROID: InstallDevice = {
  standalone: undefined,
  maxTouchPoints: 5,
  displayStandalone: false,
};
const MAC: InstallDevice = { standalone: false, maxTouchPoints: 0, displayStandalone: false };
const CLEAR = { prompt: false, dismissed: false, held: "none" as const };

function chromeEvent() {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(() => Promise.resolve()),
  });
}

let stop: () => void;

beforeEach(() => {
  window.localStorage.clear();
  stop = startInstallOffer(window);
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

describe("installForm", () => {
  it.each([
    ["an iPhone in a browser with nothing held", IPHONE, CLEAR, "steps"],
    ["the installed app, by navigator.standalone", { ...IPHONE, standalone: true }, CLEAR, null],
    [
      "the installed app, by display mode",
      { ...IPHONE, displayStandalone: true },
      { ...CLEAR, prompt: true },
      null,
    ],
    ["a Mac", MAC, CLEAR, null],
    ["Android or desktop Chrome with no event", ANDROID, CLEAR, null],
    ["dismissed", IPHONE, { ...CLEAR, dismissed: true }, null],
    ["something held", IPHONE, { ...CLEAR, held: "some" as const }, null],
    ["the held read still out", IPHONE, { ...CLEAR, held: "unknown" as const }, null],
    ["Chrome's event with nothing held", ANDROID, { ...CLEAR, prompt: true }, "button"],
    ["Chrome's event on an iPhone-shaped device", IPHONE, { ...CLEAR, prompt: true }, "button"],
    ["Chrome's event, held", ANDROID, { ...CLEAR, prompt: true, held: "some" as const }, null],
    ["Chrome's event, dismissed", ANDROID, { ...CLEAR, prompt: true, dismissed: true }, null],
  ])("%s", (_name, device, state, want) => {
    expect(installForm(device, state)).toBe(want);
  });
});

describe("deviceOf", () => {
  const media = (displayStandalone: boolean) => (q: string) =>
    new TestMediaQueryList(q, q === "(display-mode: standalone)" && displayStandalone);

  it("reads WebKit's standalone flag and the touch points", () => {
    expect(
      deviceOf({
        navigator: { standalone: false, maxTouchPoints: 5 },
        matchMedia: media(false),
      }),
    ).toEqual(IPHONE);
  });

  it("leaves standalone undefined where the browser has none", () => {
    expect(
      deviceOf({ navigator: { maxTouchPoints: 5 }, matchMedia: media(false) }).standalone,
    ).toBeUndefined();
  });

  it("reads display mode", () => {
    expect(
      deviceOf({
        navigator: { standalone: false, maxTouchPoints: 5 },
        matchMedia: media(true),
      }).displayStandalone,
    ).toBe(true);
  });
});

describe("the dismissal", () => {
  it("reads a store that throws as not dismissed", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readHintDismissed()).toBe(false);
  });

  it("keeps a dismissal for the page when the store cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      dismissInstallHint();
    }).not.toThrow();
    expect(readInstallOffer().dismissedHere).toBe(true);
    expect(readHintDismissed()).toBe(false);
  });

  it("writes the key", () => {
    dismissInstallHint();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).toBe("dismissed");
    expect(readHintDismissed()).toBe(true);
  });
});

describe("the listener and the prompt", () => {
  it("cancels Chrome's prompt and keeps the event", () => {
    const event = chromeEvent();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(readInstallOffer().prompt).toBe(event);
  });

  it("calls prompt() once for two taps", () => {
    const event = chromeEvent();
    window.dispatchEvent(event);
    promptInstall();
    promptInstall();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(readInstallOffer().prompt).toBeNull();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
  });

  it("cancels a later event on a page that has prompted, without keeping it", () => {
    window.dispatchEvent(chromeEvent());
    promptInstall();
    const later = chromeEvent();
    window.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(true);
    expect(readInstallOffer().prompt).toBeNull();
  });

  it("survives a prompt() that rejects", async () => {
    const event = chromeEvent();
    event.prompt.mockImplementation(() => Promise.reject(new Error("not allowed")));
    window.dispatchEvent(event);
    expect(() => {
      promptInstall();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(event.prompt).toHaveBeenCalled();
    });
  });

  it("drops the event when the app is installed", () => {
    window.dispatchEvent(chromeEvent());
    window.dispatchEvent(new Event("appinstalled"));
    expect(readInstallOffer().prompt).toBeNull();
  });

  it("stops listening when stopped", () => {
    stop();
    const event = chromeEvent();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    stop = startInstallOffer(window);
  });
});
