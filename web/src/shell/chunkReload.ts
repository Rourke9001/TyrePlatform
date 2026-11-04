// A lazy manager route (TYRE-238) can fail to load: a tab open across a
// deploy, or a dropped request on a depot connection. Vite's preload helper
// dispatches `vite:preloadError` on window for both a failed dependency
// preload and a failed base import(), cancelable, so one listener covers
// both. React.lazy caches the rejection and the failed component then
// throws during render; a reload against a fresh deploy is the recovery.
// While the guard window (below) is open, the throw reaches React and
// RouteErrorBoundary renders the retry (TYRE-280).
const PRELOAD_ERROR_EVENT = "vite:preloadError";
const STAMP_KEY = "chunkReloadAt";

// Long enough that a genuinely broken deployment does not reload-loop the
// tab; short enough that a second, unrelated chunk failure soon after still
// recovers.
const RELOAD_GUARD_WINDOW_MS = 10_000;

// The token store's import of the sign-in library (ADR-0016) fails like any
// chunk and dispatches the same event. In a dead zone that is a network
// failure the outbox retries, never an automatic reload; only a tap reloads
// (reloadForAuthChunk). Vite dispatches the event before the import rejects,
// so the count is still held when it fires.
let suppressed = 0;

// On an object so a test can replace it: jsdom implements no navigation.
export const page = { reload: (): void => window.location.reload() };

// The one loop guard both reloads share: none inside the window after the
// last, stamped first. Blocked storage (private mode, quota, or a
// SecurityError merely reading window.sessionStorage: all cookies blocked, a
// sandboxed iframe) means no guard is possible, and reloading without one
// risks looping on a chunk that never becomes reachable, so it answers false
// (TYRE-280). The storage is resolved inside the try: install runs in main.tsx
// before the first render, and a throw there would blank the whole app,
// capture flow included (TYRE-238).
function stampReload(storage: Pick<Storage, "getItem" | "setItem"> | undefined, now: number) {
  try {
    const store = storage ?? window.sessionStorage;
    const stamp = store.getItem(STAMP_KEY);
    // A clock corrected backwards leaves the stamp in the future, which is
    // not recent; the reload re-stamps at the corrected time.
    const age = stamp === null ? NaN : now - Number(stamp);
    if (age >= 0 && age < RELOAD_GUARD_WINDOW_MS) return false;
    store.setItem(STAMP_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

// U105 (TYRE-381): Chrome and released Safari keep a failed module fetch in
// the module map for the life of the page, so after one failed import of the
// auth chunk only a reload loads it again. A tap on Sign in or Sign out
// reloads; a renewal never does. Offline the reload would strand the driver
// on the browser's offline page (no service worker, ADR-0009), so it reloads
// only while the phone reports a connection, and once inside the guard
// window, so a chunk that fails on every load shows the line (U172). Returns
// whether it reloaded.
export function reloadForAuthChunk(): boolean {
  if (!window.navigator.onLine || !stampReload(undefined, Date.now())) return false;
  page.reload();
  return true;
}

export function suppressReloadWhile<T>(pending: Promise<T>): Promise<T> {
  suppressed += 1;
  return pending.finally(() => {
    suppressed -= 1;
  });
}

export interface ChunkReloadDeps {
  reload: () => void;
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
}

// Injectable so a test never touches window.location; the real defaults are
// what main.tsx installs.
export function installChunkReload(deps: Partial<ChunkReloadDeps> = {}): () => void {
  const reload = deps.reload ?? page.reload;
  const now = deps.now ?? Date.now;

  // Without a reload the error reaches RouteErrorBoundary, which offers the
  // retry (TYRE-280).
  function handlePreloadError() {
    if (suppressed > 0) return;
    if (stampReload(deps.storage, now())) reload();
  }

  // Never preventDefault: with it, Vite's preload helper resolves the
  // import to undefined and routes.tsx's .then((m) => ({ default: m.X }))
  // throws a TypeError anyway, so the error reaches React on both paths.
  // RouteErrorBoundary renders the retry until the reload lands (TYRE-280).
  window.addEventListener(PRELOAD_ERROR_EVENT, handlePreloadError);
  return () => window.removeEventListener(PRELOAD_ERROR_EVENT, handlePreloadError);
}
