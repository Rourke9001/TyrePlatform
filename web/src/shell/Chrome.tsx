import type { ReactNode } from "react";
import { matchPath, useLocation } from "react-router";

import { useActor, useActorSettled, useCan } from "../auth/actorContext";
import { SignInLine } from "../auth/SignInLine";
import { SignOutButton } from "../auth/SignOutButton";
import { OutboxIndicator } from "../capture/OutboxIndicator";
import { useBranding } from "../theme/themeContext";
import { AppShell } from "../ui/AppShell";
import { BrandMark } from "../ui/BrandMark";
import { DriverShell } from "../ui/DriverShell";
import { DevBar } from "./DevBar";
import { navGroupsFor, navItemsFor } from "./navigation";
import "./shell.css";

const PLATFORM = "Fleet tyre platform";

// The frame every route renders in (ADR-0020): AppShell for an actor who can
// view the fleet, DriverShell for everyone else. Until GET /api/me settles it
// is the driver's frame, because the outbox has to show before any actor does
// (ADR-0009), and one frame for both means a driver's page is never remounted
// when the actor arrives. Both are static: a lazy shell would sit in front of
// capture for a manager who captures, and outside RouteErrorBoundary (U54).
export function Chrome({ children }: { children: ReactNode }) {
  const settled = useActorSettled();
  const manager = useCan("ViewFleet");
  const actor = useActor();
  const { branding } = useBranding();
  const { pathname } = useLocation();

  // Never the security boundary (NFR-SEC-006): the server re-checks every
  // capability on every request. This only shows who the app thinks is
  // asking.
  const actorLine = actor ? `${actor.displayName} · ${actor.role}` : undefined;
  // A logo exists only once upload and serving land with RBAC (TYRE-26), so
  // the monogram tile is the designed default, not a degraded state.
  const mark = { name: branding.displayName, logoUrl: branding.logoUrl, onBrand: true };
  // A driver who navigated away from capture still needs to know an
  // inspection is waiting to send and which one needs a person
  // (FR-OFF-010/013).
  const status = <OutboxIndicator />;

  if (settled && manager) {
    return (
      <AppShell
        nav={navGroupsFor(actor?.capabilities ?? [])}
        brand={<BrandMark {...mark} subtitle={PLATFORM} />}
        actor={actorLine}
        signOut={<SignOutButton />}
        status={status}
        signIn={<SignInLine />}
        devBar={<DevBar />}
      >
        {children}
      </AppShell>
    );
  }
  // U159: a driver has a link to their own page from every other page; the
  // link to the page they are on is left out.
  const driverNav = navItemsFor(actor?.capabilities ?? []).filter(
    (item) => matchPath(item.to, pathname) === null,
  );
  // The tile is decoration here; the bar's title carries the name.
  return (
    <DriverShell
      brand={<BrandMark {...mark} showName={false} size="sm" aria-hidden="true" />}
      barTitle={branding.displayName}
      barSubtitle={PLATFORM}
      actor={actorLine}
      signOut={<SignOutButton size="glove" />}
      nav={driverNav}
      status={status}
      signIn={<SignInLine />}
      devBar={<DevBar />}
    >
      {children}
    </DriverShell>
  );
}
