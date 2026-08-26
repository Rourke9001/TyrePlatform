import type { ReactNode } from "react";
import { NavLink } from "react-router";
import {
  DEV_ACTORS,
  DEV_TENANTS,
  clearDevActorId,
  clearDevTenantId,
  getDevActorId,
  getDevTenantId,
  setDevActorId,
  setDevTenantId,
} from "../api/devTenant";
import { useActor } from "../auth/actorContext";
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

// Dev stand-in for real tenant context until the IdP slice (TYRE-2); the
// API only honours the header behind APP_DEV_TENANT_HEADER=1. Reload on
// change: theme, cache keys and every query re-enter cleanly for the new
// tenant, which is exactly the from-scratch state worth demonstrating.
function DevTenantSwitcher() {
  if (!import.meta.env.DEV) return null;
  const current = getDevTenantId() ?? "";
  return (
    <label className="shell-tenant">
      Tenant (dev)
      <select
        value={current}
        onChange={(e) => {
          if (e.target.value) {
            setDevTenantId(e.target.value);
          } else {
            clearDevTenantId();
          }
          window.location.reload();
        }}
      >
        <option value="">Platform default</option>
        {DEV_TENANTS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// Dev stand-in for real user identity until the IdP slice (TYRE-2). Switching
// actor also switches that actor's tenant, since a driver on tenant B does
// not exist under tenant A's rows — reload for the same from-scratch reason
// as DevTenantSwitcher.
function DevActorSwitcher() {
  if (!import.meta.env.DEV) return null;
  const current = getDevActorId() ?? "";
  return (
    <label className="shell-tenant">
      Actor (dev)
      <select
        value={current}
        onChange={(e) => {
          const actor = DEV_ACTORS.find((a) => a.id === e.target.value);
          if (actor) {
            setDevActorId(actor.id);
            setDevTenantId(actor.tenant);
          } else {
            clearDevActorId();
          }
          window.location.reload();
        }}
      >
        <option value="">No user (every request 401s)</option>
        {DEV_ACTORS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
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

// navItemsFor has already filtered against the registry (../shell/navigation,
// which holds the one-list rationale), so no per-link gating here.
function MainNav() {
  const actor = useActor();
  const items = navItemsFor(actor?.capabilities ?? []);
  if (items.length === 0) return null;
  return (
    <nav className="shell-nav" aria-label="Main">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to}>
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
        <DevTenantSwitcher />
        <DevActorSwitcher />
      </header>
      <MainNav />
      <main className="shell-main">{children}</main>
    </div>
  );
}
