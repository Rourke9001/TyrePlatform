import { Component, type ReactNode } from "react";
import { useLocation, useMatch } from "react-router";

interface BoundaryProps {
  resetKey: string;
  onCapture: boolean;
  inPlace: boolean;
  reload: () => void;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  resetKey: string;
}

// U54: the one class component in web/src, a named exception to CLAUDE.md's
// rule, because React catches a render error only in a class. It sits
// inside <main>, so the nav and the outbox indicator stay mounted.
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  // A navigation clears the error, as react-router's own boundary does: with
  // the nav still mounted, picking another page is how a user leaves a
  // broken one.
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  // The driver's routes are static in the entry chunk, so clearing the error
  // remounts them in place: a reload would strand a driver without signal on
  // the browser's offline page, since there is no service worker (ADR-0009).
  // Every other route is lazy, and React caches a rejected import, so only a
  // reload helps there (TYRE-280).
  private readonly retry = (): void => {
    if (this.props.inPlace) this.setState({ failed: false });
    else this.props.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="route-error" role="alert">
        <p>This page could not be shown.</p>
        {this.props.onCapture && <p>Readings already entered are kept on this phone.</p>}
        <button type="button" className="btn btn-secondary" onClick={this.retry}>
          Try again
        </button>
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
  const inPlace = onCapture || onDriverHome;
  return (
    <Boundary resetKey={key} onCapture={onCapture} inPlace={inPlace} reload={reload}>
      {children}
    </Boundary>
  );
}
