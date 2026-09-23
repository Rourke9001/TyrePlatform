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

// Dev stand-in for tenant context until the IdP slice (TYRE-2); the API only
// honours the header behind APP_DEV_TENANT_HEADER=1. Reload on change so
// every query re-enters cleanly for the new tenant.
function DevTenantSwitcher() {
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

// Dev stand-in for identity until TYRE-2. Switching actor also switches
// tenant, since a driver on tenant B has no rows under tenant A.
function DevActorSwitcher() {
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

// Collapsed, after the main content, never in the header (TYRE-242): on a
// phone the two selects pushed the capture sheet below the fold. The
// summary still says who the app thinks is asking, since a shared dev
// environment needs that at a glance (NFR-SEC-006 makes it a courtesy).
export function DevBar() {
  if (!import.meta.env.DEV) return null;
  const tenant = DEV_TENANTS.find((t) => t.id === getDevTenantId())?.name ?? "platform default";
  const actor = DEV_ACTORS.find((a) => a.id === getDevActorId())?.name ?? "no user";
  return (
    <details className="dev-bar">
      <summary>
        Dev: {tenant}, {actor}
      </summary>
      <div className="dev-bar-controls">
        <DevTenantSwitcher />
        <DevActorSwitcher />
      </div>
    </details>
  );
}
