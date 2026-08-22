import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchBranding, type Branding } from "../api/branding";
import { getDevTenantId } from "../api/devTenant";
import { deriveBrandTheme } from "./derive";
import { applyCssVars, cssVars, palette } from "./tokens";
import { ThemeContext } from "./themeContext";
import "./fonts";
import "./base.css";

// What renders when no tenant branding is known yet — also exactly what the
// API serves for a tenant that never configured the key (TYRE-26), so first
// paint and fetched state agree for unbranded tenants.
const PLATFORM_BRANDING: Branding = {
  displayName: "Tyre Platform",
  primaryColor: palette.brand,
  logoUrl: null,
};

// Branding is cached per tenant, not under one key: the dev tenant switcher
// (TYRE-28) flips tenants in place, and one shared key would paint tenant
// A's colours on tenant B until the fetch lands.
function cacheKey(tenantKey: string): string {
  return `tyre.branding.${tenantKey}`;
}

function readCachedBranding(tenantKey: string): Branding | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(tenantKey));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Branding).displayName === "string" &&
      typeof (parsed as Branding).primaryColor === "string"
    ) {
      return parsed as Branding;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCachedBranding(tenantKey: string, branding: Branding): void {
  try {
    window.localStorage.setItem(cacheKey(tenantKey), JSON.stringify(branding));
  } catch {
    // A full or unavailable store only costs the next reload its instant
    // brand; the fetch still themes this session.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const tenantKey = getDevTenantId() ?? "default";

  // Last-known branding paints the first frame so a reload or offline start
  // shows the right brand with no flash-of-default; the fetch then confirms
  // or corrects it.
  const cached = useMemo(() => readCachedBranding(tenantKey), [tenantKey]);

  const query = useQuery({
    queryKey: ["branding", tenantKey],
    queryFn: fetchBranding,
    staleTime: 5 * 60 * 1000,
  });

  const branding = query.data ?? cached ?? PLATFORM_BRANDING;
  const theme = useMemo(() => deriveBrandTheme(branding.primaryColor), [branding.primaryColor]);

  // Layout effect: the variables must be on the root before the browser
  // paints the frame that uses them.
  useLayoutEffect(() => {
    applyCssVars(document.documentElement, cssVars(theme));
  }, [theme]);

  useEffect(() => {
    if (query.data) writeCachedBranding(tenantKey, query.data);
  }, [tenantKey, query.data]);

  const value = useMemo(() => ({ branding, theme }), [branding, theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
