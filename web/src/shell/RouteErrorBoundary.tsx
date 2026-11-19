import { useQueryClient } from "@tanstack/react-query";
import { Component, createRef, type ReactNode } from "react";
import { useLocation, useMatch } from "react-router";

import { bounded } from "../api/deadline";
import { useActor } from "../auth/actorContext";
import { refreshCaptureContexts } from "../capture/captureContext";
import { ErrorDiscard } from "../capture/ErrorDiscard";
import { useStorageFaults, type StorageFaults } from "../capture/storageFaults";
import { refreshDriverHome } from "../driver/driver.data";
import { Button } from "../ui/Button";
import "./shell.css";

interface BoundaryProps {
  resetKey: string;
  // The driver's two static routes, which remount in place; null is every
  // other route, whose retry is a reload.
  route: "capture" | "home" | null;
  storage: StorageFaults;
  // The route's server data fetched again, for the escalated retry (TYRE-340).
  refresh: () => Promise<void>;
  reload: () => void;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  resetKey: string;
  // In-place retries made at this location. The second failure is the first
  // one caught after a retry, so retries > 0 means escalated.
  retries: number;
  busy: boolean;
}

// TYRE-339: what the driver is told about the readings already entered.
// Degraded wins over unavailable, since a phone that refused to save and also
// failed a write may be missing readings; unavailable alone never held an
// inspection, so there is nothing to say.
function readingsLine(storage: StorageFaults): string | null {
  if (storage.degraded) {
    return "This phone was not saving reliably, so the last readings you entered may be missing. Check each position after you try again.";
  }
  return storage.unavailable ? null : "Readings already entered are kept on this phone.";
}

// U54: the one class component in web/src, a named exception to CLAUDE.md's
// rule, because React catches a render error only in a class. It sits
// inside <main>, so the shell around it stays mounted: the bar, any nav
// and the outbox indicator.
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {
    failed: false,
    resetKey: this.props.resetKey,
    retries: 0,
    busy: false,
  };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  // A navigation clears the error and the count, as react-router's own
  // boundary clears the error: picking another page from the nav is how a
  // user leaves a broken one. A driver's nav links to /my from every other
  // page (U159). A commit does not reset the count, since a page that throws
  // on its draft commits "Loading…" first (useDraftLifecycle.ts, TYRE-340).
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey, retries: 0, busy: false };
  }

  // Bumped by every escalated retry and every recovery, so only the latest
  // attempt's result may remount: a navigation or a later attempt during the
  // wait wins (TYRE-340).
  private attempt = 0;

  private readonly frame = createRef<HTMLDivElement>();

  // The main landmark the error screen sits in, set when a recovery starts.
  private refocus: HTMLElement | null = null;

  // TYRE-335: the Try again button is removed with the error screen, so focus
  // falls to the body (WAI-ARIA APG, keyboard interface). It moves to the main
  // landmark unless the recovered page took focus in its own commit, such as a
  // reopened position sheet, which wins.
  componentDidUpdate(): void {
    const main = this.refocus;
    this.refocus = null;
    if (main === null || this.state.failed) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus();
  }

  private recover(retries: number): void {
    this.refocus = this.frame.current?.closest("main") ?? null;
    this.attempt += 1;
    this.setState({ failed: false, busy: false, retries });
  }

  // A discard that succeeded is a fresh start: the page remounts on the start
  // screen, and the count begins again (TYRE-333).
  private readonly discarded = (): void => this.recover(0);

  // The driver's routes are static in the entry chunk, so clearing the error
  // remounts them in place: a reload would strand a driver without signal on
  // the browser's offline page, since there is no service worker (ADR-0009).
  // Every other route is lazy, and React caches a rejected import, so only a
  // reload helps there (TYRE-280).
  private readonly retry = (): void => {
    if (this.props.route === null) {
      this.props.reload();
      return;
    }
    if (this.state.busy) return;
    if (this.state.retries === 0) {
      this.recover(1);
      return;
    }
    this.attempt += 1;
    const attempt = this.attempt;
    const at = this.state.resetKey;
    this.setState({ busy: true });
    void bounded(this.props.refresh(), "refresh")
      .catch(() => undefined)
      .then(() => {
        if (attempt === this.attempt && this.state.resetKey === at) {
          this.recover(this.state.retries + 1);
        }
      });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { route, storage } = this.props;
    const escalated = route !== null && this.state.retries > 0;
    const readings = route === "capture" ? readingsLine(storage) : null;
    return (
      <div ref={this.frame} className="route-error" role="alert">
        <p className="route-error__lead">
          {escalated ? "This page still cannot be shown." : "This page could not be shown."}
        </p>
        {escalated && <p>Try again fetches a fresh copy first. Find signal if you can.</p>}
        {readings !== null && <p>{readings}</p>}
        {/* NFR-USE-004: the driver's routes take the glove size. aria-disabled,
            not disabled, so focus stays on the button while it waits. */}
        <Button
          variant={escalated ? "primary" : "secondary"}
          size={route !== null ? "glove" : "md"}
          block={escalated}
          aria-disabled={this.state.busy}
          onClick={this.retry}
        >
          {this.state.busy ? "Trying again…" : "Try again"}
        </Button>
        {/* Discard can show when the cause is server data, which is accepted:
            the confirmation names what is lost, and Try again comes first
            (TYRE-333). */}
        {escalated && route === "capture" && <ErrorDiscard onDiscarded={this.discarded} />}
      </div>
    );
  }
}

export function RouteErrorBoundary({
  children,
  reload = () => window.location.reload(),
}: {
  children: ReactNode;
  reload?: () => void;
}) {
  const { key } = useLocation();
  // routes.tsx's patterns for CaptureFlow and DriverHome, matched the way the
  // router matches them: case, a trailing slash and percent-encoding included.
  const onCapture = useMatch("/capture/:vehicleId") !== null;
  const onDriverHome = useMatch("/my") !== null;
  const route = onCapture ? "capture" : onDriverHome ? "home" : null;
  const storage = useStorageFaults();
  const client = useQueryClient();
  const timeZone = useActor()?.timezone ?? "UTC";
  const refresh = () =>
    route === "capture" ? refreshCaptureContexts(client, timeZone) : refreshDriverHome(client);
  return (
    <Boundary resetKey={key} route={route} storage={storage} refresh={refresh} reload={reload}>
      {children}
    </Boundary>
  );
}
