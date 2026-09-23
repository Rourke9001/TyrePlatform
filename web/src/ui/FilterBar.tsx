import type { ReactNode } from "react";

import { Button } from "./Button";

interface FilterBarProps {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}

// FR-DSH-013's refresh lives with the filters because it is the only way
// the page refetches (U41): no polling, no refetch on focus.
export function FilterBar({ children, onRefresh, refreshing = false }: FilterBarProps) {
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <div className="filter-bar-controls">{children}</div>
      {onRefresh && (
        <>
          {/* aria-disabled, not disabled: a disabled button drops the focus of
              the keyboard user who pressed it (WCAG 2.4.3), and the status
              line says what the label swap alone does not announce. */}
          <Button
            variant="secondary"
            aria-disabled={refreshing || undefined}
            onClick={() => {
              if (!refreshing) onRefresh();
            }}
          >
            {refreshing ? "Refreshing" : "Refresh"}
          </Button>
          <span role="status" className="visually-hidden">
            {refreshing ? "Refreshing" : ""}
          </span>
        </>
      )}
    </div>
  );
}
