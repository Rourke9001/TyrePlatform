import type { ReactNode } from "react";

import { Button } from "../ui/Button";
import { RefreshIcon } from "../ui/icons/Refresh";

interface FilterBarProps {
  children?: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
}

// FR-DSH-013's refresh lives with the filters because it is the only way
// these pages refetch (U41): no polling, no refetch on focus.
export function FilterBar({ children, onRefresh, refreshing }: FilterBarProps) {
  return (
    <div className="list-filters" role="group" aria-label="Filters">
      <div className="list-filters__controls">{children}</div>
      {/* aria-disabled, not disabled: a disabled button drops the focus of
          the keyboard user who pressed it (WCAG 2.4.3), and the status line
          says what the label swap alone does not announce. */}
      <Button
        variant="secondary"
        icon={RefreshIcon}
        aria-disabled={refreshing || undefined}
        onClick={() => {
          if (!refreshing) onRefresh();
        }}
      >
        {refreshing ? "Refreshing" : "Refresh"}
      </Button>
      <span role="status" className="tr-vh">
        {refreshing ? "Refreshing" : ""}
      </span>
    </div>
  );
}
