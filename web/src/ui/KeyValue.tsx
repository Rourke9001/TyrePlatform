import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./KeyValue.css";

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  // Figures, codes and sizes in the mono face.
  mono?: boolean;
}

export interface KeyValueProps extends HTMLAttributes<HTMLDListElement> {
  items: KeyValueItem[];
  // A maximum: the grid reflows below each column's minimum width.
  columns?: 1 | 2 | 3 | 4;
}

export function KeyValue({ items, columns = 2, className, style, ...rest }: KeyValueProps) {
  return (
    <dl
      className={cx("tr-kv", className)}
      style={{ "--tr-kv-cols": columns, ...style } as CSSProperties}
      {...rest}
    >
      {items.map((item, i) => (
        <div key={`${i}-${item.label}`} className="tr-kv__item">
          <dt>{item.label}</dt>
          <dd data-mono={item.mono ? "true" : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
