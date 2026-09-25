// A lazy manager route (TYRE-238) can fail to load: a tab open across a
// deploy, or a dropped request on a depot connection. Vite's preload helper
// dispatches `vite:preloadError` on window for both a failed dependency
// preload and a failed base import(), cancelable, so one listener covers
// both. React.lazy caches the rejection and the failed component then
// throws during render, unmounting the whole root; a reload against a fresh
// deploy is the recovery. While the guard window (below) is open, the throw
// reaches React and RouteErrorBoundary renders the retry (TYRE-280).
const PRELOAD_ERROR_EVENT = "vite:preloadError";
const STAMP_KEY = "chunkReloadAt";

// Long enough that a genuinely broken deployment does not reload-loop the
// tab; short enough that a second, unrelated chunk failure soon after still
// recovers.
const RELOAD_GUARD_WINDOW_MS = 10_000;

export interface ChunkReloadDeps {
  reload: () => void;
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
}

// Injectable so a test never touches window.location; the real defaults are
// what main.tsx installs.
export function installChunkReload(deps: Partial<ChunkReloadDeps> = {}): () => void {
  const reload = deps.reload ?? (() => window.location.reload());
  const now = deps.now ?? Date.now;

  function handlePreloadError() {
    // Blocked storage (private mode, quota, or a SecurityError merely
    // reading window.sessionStorage: all cookies blocked, a sandboxed
    // iframe) means no guard is possible; reloading without one risks
    // looping on a chunk that never becomes reachable, so this leaves the
    // error to reach RouteErrorBoundary instead (TYRE-280).
    let storage: Pick<Storage, "getItem" | "setItem">;
    let lastReloadAt: number | null;
    try {
      // Resolved here, inside the try, rather than at install time: install
      // runs in main.tsx before createRoot(...).render, and a throw there
      // would blank the whole app, capture flow included (TYRE-238).
      storage = deps.storage ?? window.sessionStorage;
      const stamp = storage.getItem(STAMP_KEY);
      lastReloadAt = stamp === null ? null : Number(stamp);
    } catch {
      return;
    }

    if (lastReloadAt !== null && now() - lastReloadAt < RELOAD_GUARD_WINDOW_MS) return;

    try {
      storage.setItem(STAMP_KEY, String(now()));
    } catch {
      return;
    }
    reload();
  }

  // Never preventDefault: with it, Vite's preload helper resolves the
  // import to undefined and routes.tsx's .then((m) => ({ default: m.X }))
  // throws a TypeError anyway, so the error reaches React on both paths.
  // RouteErrorBoundary renders the retry until the reload lands (TYRE-280).
  window.addEventListener(PRELOAD_ERROR_EVENT, handlePreloadError);
  return () => window.removeEventListener(PRELOAD_ERROR_EVENT, handlePreloadError);
}
