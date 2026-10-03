// Context and hook live apart from the provider: a module exporting both a
// component and a non-component loses Vite fast refresh for the whole file
// (TYRE-49, react-refresh/only-export-components).

import { createContext, useContext } from "react";
import type { Branding } from "../api/branding";
import type { BrandTheme } from "./derive";

export interface ThemeContextValue {
  branding: Branding;
  theme: BrandTheme;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useBranding(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useBranding must be used inside ThemeProvider");
  }
  return ctx;
}
