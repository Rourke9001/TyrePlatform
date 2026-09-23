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
        <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      )}
    </div>
  );
}
