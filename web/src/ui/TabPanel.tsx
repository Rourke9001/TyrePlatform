import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./TabPanel.css";

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  // The panelId of its tab, and that tab's id.
  id: string;
  labelledBy: string;
  active: boolean;
  children?: ReactNode;
}

// Every panel stays mounted, so a panel keeps its state when its tab is
// left; `hidden` takes the inactive ones out of view and the tree.
export function TabPanel({ id, labelledBy, active, className, children, ...rest }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      hidden={!active}
      tabIndex={0}
      className={cx("tr-tabpanel", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
