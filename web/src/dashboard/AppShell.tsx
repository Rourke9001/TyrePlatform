import type { ReactNode } from "react";
import { DEV_TENANTS, clearDevTenantId, getDevTenantId, setDevTenantId } from "../api/devTenant";
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

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-brand">
          <p className="shell-eyebrow">Fleet tyre platform</p>
          <BrandMark />
        </div>
        <DevTenantSwitcher />
      </header>
      <nav className="shell-nav" aria-label="Main">
        <a href="/" aria-current="page">
          Vehicles
        </a>
      </nav>
      <main className="shell-main">{children}</main>
    </div>
  );
}
