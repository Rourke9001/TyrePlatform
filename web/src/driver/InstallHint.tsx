import { useEffect, useId, useState, type RefObject } from "react";

import { readHeldWork } from "../capture/outbox";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import {
  deviceOf,
  dismissInstallHint,
  installForm,
  promptInstall,
  readHintDismissed,
  useInstallOffer,
  type HeldState,
} from "./installOffer";

// Read when the hint would otherwise show, never earlier. A draft or outbox
// entry held on this phone hides the hint, whoever captured it: an installed
// iOS app has its own storage, so installing now would strand it (TYRE-154,
// U243). A failed read hides it too. The effect keeps no "already read"
// guard: StrictMode runs it twice in dev, and a guard would drop the first
// answer and block the second.
function useHeldWork(enabled: boolean): HeldState {
  const [held, setHeld] = useState<HeldState>("unknown");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    readHeldWork().then(
      (work) => {
        if (live) setHeld(work.draft !== null || work.entries > 0 ? "some" : "none");
      },
      () => {
        if (live) setHeld("some");
      },
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return held;
}

export function InstallHint({ focusAfter }: { focusAfter: RefObject<HTMLElement | null> }) {
  const offer = useInstallOffer();
  const titleId = useId();
  const device = deviceOf(window);
  const prompt = offer.prompt !== null;
  const dismissed = offer.dismissedHere || readHintDismissed();
  const held = useHeldWork(installForm(device, { prompt, dismissed, held: "none" }) !== null);
  const form = installForm(device, { prompt, dismissed, held });
  if (form === null) return null;

  // Focus moves before the hint goes, so it never falls to the body.
  const done = (act: () => void) => () => {
    focusAfter.current?.focus();
    act();
  };

  return (
    <Banner
      tone="info"
      aria-labelledby={titleId}
      title={
        <h2 id={titleId} className="driver-home__install-title">
          {form === "steps" ? "Add this app to your Home Screen" : "Install this app"}
        </h2>
      }
    >
      {form === "steps" ? (
        <>
          <p className="driver-home__install-text">
            Tap Share, then Add to Home Screen. If you cannot see Share, tap the menu button (...)
            first.
          </p>
          <p className="driver-home__install-text">
            You will sign in once more when you open it from the Home Screen.
          </p>
        </>
      ) : (
        <p className="driver-home__install-text">
          It opens from your Home screen like any other app.
        </p>
      )}
      <div className="driver-home__install-actions">
        {form === "button" && (
          <Button size="glove" variant="secondary" onClick={done(promptInstall)}>
            Install
          </Button>
        )}
        <Button
          size="glove"
          variant={form === "steps" ? "secondary" : "ghost"}
          onClick={done(dismissInstallHint)}
        >
          {form === "steps" ? "Got it" : "No thanks"}
        </Button>
      </div>
    </Banner>
  );
}
