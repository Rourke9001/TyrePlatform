import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useActor } from "../auth/actorContext";
import { OutboxIndicator } from "../capture/OutboxIndicator";
import { DevBar } from "../shell/DevBar";
import { navItemsFor } from "../shell/navigation";
import { useBranding } from "../theme/themeContext";
import "./dashboard.css";

// A logo only exists once upload/serving lands with RBAC (TYRE-26), so the
// type-set wordmark is the designed default, not a degraded state.
function BrandMark() {
  const { branding } = useBranding();
  if (branding.logoUrl) {
    return <img className="shell-logo" src={branding.logoUrl} alt={branding.displayName} />;
  }
  return <span className="shell-wordmark">{branding.displayName}</span>;
}

// Never the security boundary (NFR-SEC-006): the server re-checks every
// capability on every request. This is only a courtesy so it is obvious, in
// a shared dev environment, who the app currently thinks is asking.
function ActorBadge() {
  const actor = useActor();
  if (!actor) return null;
  return (
    <p className="shell-actor">
      {actor.displayName} · {actor.role}
    </p>
  );
}

// navItemsFor already filtered against the registry, so no per-link gating
// here. `end` on every link: paths nest, and NavLink's default prefix match
// would mark all ancestors current at once.
function MainNav() {
  const actor = useActor();
  const items = navItemsFor(actor?.capabilities ?? []);
  if (items.length === 0) return null;
  return (
    <nav className="shell-nav" aria-label="Main">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-brand">
          <p className="shell-eyebrow">Fleet tyre platform</p>
          <BrandMark />
          <ActorBadge />
        </div>
      </header>
      {/* A driver who navigated away from capture still needs to know an
          inspection is waiting to send and which one needs a person
          (FR-OFF-010/013). */}
      <OutboxIndicator />
      <MainNav />
      <main className="shell-main">{children}</main>
      <DevBar />
    </div>
  );
}
