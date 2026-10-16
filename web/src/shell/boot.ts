// The order the app starts in (ADR-0019). Section 3 of
// docs/superpowers/specs/2026-10-16-platform-readiness-design.md.

export interface BootSteps {
  loadConfig(): Promise<void>;
  completeRedirect(): Promise<unknown>;
  render(): void;
  renderFailure(retry: () => void, busy: boolean): void;
  onOnline(listener: () => void): () => void;
}

// Settles once the app has rendered, and stays pending while the
// configuration keeps failing.
export function boot(steps: BootSteps): Promise<void> {
  return new Promise((resolve) => {
    let inFlight = false;
    let failed = false;
    let unsubscribe: (() => void) | null = null;
    // In place, never a reload: a reload strands a driver without signal on
    // the browser's offline page, since there is no service worker
    // (ADR-0009), and the app's own online listener (FR-OFF-009) exists only
    // once it renders.
    const attempt = (): void => {
      if (inFlight) return;
      inFlight = true;
      // A retry shows itself: on a stalled connection it can run for
      // REQUEST_TIMEOUT_SECONDS, and a gloved driver cannot otherwise tell a
      // tap that landed from one that did not.
      if (failed) steps.renderFailure(attempt, true);
      // The configuration first: completeRedirect flushes the outbox to the
      // API, whose origin it names.
      steps.loadConfig().then(
        async () => {
          unsubscribe?.();
          unsubscribe = null;
          try {
            await steps.completeRedirect();
          } catch {
            // Logged once, with no token or URL (callback.ts).
            console.error("sign-in callback failed");
          }
          steps.render();
          resolve();
        },
        () => {
          inFlight = false;
          failed = true;
          console.error("the app could not load config.json");
          steps.renderFailure(attempt, false);
          unsubscribe ??= steps.onOnline(attempt);
        },
      );
    };
    attempt();
  });
}
