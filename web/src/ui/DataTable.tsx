import {
  useId,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cx } from "./cx";
import { usePhone } from "./useMediaQuery";
import { Icon } from "./Icon";
import { ChevronRightIcon } from "./icons/ChevronRight";
import "./DataTable.css";

export interface Column<T> {
  key: string;
  header: string;
  // Numbers align right, always.
  align?: "left" | "right";
  // Figures, codes and sizes in the mono face.
  mono?: boolean;
  // A money figure never stands without its basis (TYRE-176, ADR-0010);
  // the column that carries it is set as the figure's footnote.
  basis?: boolean;
  // Short values (codes, times, fleet numbers) stay on one line.
  nowrap?: boolean;
  // Names the row for a screen reader: its desktop cells are th scope="row".
  // One per table; the first wins. Cards are unchanged.
  rowHeader?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> extends HTMLAttributes<HTMLDivElement> {
  // Names the table, and the card list on a phone.
  caption: string;
  // Today's pages title a table themselves, so the caption is read, not drawn.
  captionVisible?: boolean;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  // Opens a row's detail; the row becomes a target with a chevron.
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  // Marks a row with the critical edge, beside the words that say why.
  rowTone?: (row: T) => "critical" | undefined;
  // Replaces an empty table, which reads as a broken one.
  empty?: ReactNode;
  // Passing it, true or false, mounts the status line that announces a load.
  // A screen with its own status region leaves it out and keeps a single
  // role="status".
  loading?: boolean;
  // The phone form heads each card under the heading the table sits beneath.
  cardHeadingLevel?: 2 | 3 | 4;
}

const SKELETON_ROWS = [0, 1, 2, 3];

const CONTROL = "a, button, input, select, textarea, label, summary, [role='button'], [tabindex]";

// A link, button or field inside a clickable row keeps its own action, as
// today's tyre rows' "Price it on its receipt" does (e2e/tyres.spec.ts):
// the row opens only from its own cells.
function fromControl(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): boolean {
  if (!(event.target instanceof Element)) return false;
  const control = event.target.closest(CONTROL);
  return (
    control !== null && control !== event.currentTarget && event.currentTarget.contains(control)
  );
}

function cellData<T>(column: Column<T>) {
  return {
    "data-align": column.align,
    "data-mono": column.mono ? "true" : undefined,
    "data-basis": column.basis ? "true" : undefined,
    "data-nowrap": column.nowrap ? "true" : undefined,
  };
}

// Below breakpoint.phone the rows become cards by usePhone(), not by CSS: a
// table set to display: block loses its semantics for a screen reader
// (TYRE-238 comment 12938).
export function DataTable<T>({
  caption,
  captionVisible = false,
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  rowTone,
  empty,
  loading,
  cardHeadingLevel = 3,
  className,
  ...rest
}: DataTableProps<T>) {
  const phone = usePhone();
  const captionId = useId();
  // NVDA and JAWS do not announce aria-busy, so a status line says the load
  // (WCAG 4.1.3). It heads every form, so one live region outlasts the
  // switch from loading to rows or to empty.
  const status =
    loading === undefined ? null : (
      <p role="status" className="tr-vh">
        {loading ? `Loading ${caption}` : ""}
      </p>
    );
  const frame = (body: ReactNode) => (
    <div className={cx("tr-table-wrap", className)} {...rest}>
      {status}
      {body}
    </div>
  );

  if (!loading && rows.length === 0 && empty !== undefined) return frame(empty);

  if (phone) {
    const Heading = `h${cardHeadingLevel}` as const;
    const [first, ...others] = columns;
    return frame(
      <>
        {captionVisible ? (
          <p id={captionId} className="tr-tcards__caption">
            {caption}
          </p>
        ) : null}
        {/* role="list" because WebKit drops list semantics from a ul styled
            list-style: none, and VoiceOver then reads no count. */}
        <ul
          className="tr-tcards"
          role="list"
          aria-label={captionVisible ? undefined : caption}
          aria-labelledby={captionVisible ? captionId : undefined}
          aria-busy={loading === true ? true : undefined}
        >
          {loading
            ? SKELETON_ROWS.map((i) => (
                <li key={i} className="tr-tcards__card">
                  {/* A div, not a heading: an empty heading is announced
                      with nothing after it. */}
                  <div className="tr-tcards__title">
                    <span className="tr-table__skeleton" />
                  </div>
                  <span className="tr-table__skeleton" />
                </li>
              ))
            : rows.map((row, i) => {
                const key = rowKey(row);
                const titleId = `${captionId}-${i}`;
                return (
                  <li
                    key={key}
                    className="tr-tcards__card"
                    data-tone={rowTone?.(row)}
                    aria-current={selectedKey === key ? "true" : undefined}
                  >
                    {/* The button is named by the title, not wrapped round
                        it: a control in the first column stays its own,
                        outside the button. */}
                    <div className="tr-tcards__head">
                      <Heading className="tr-tcards__title" id={titleId}>
                        {first.render(row)}
                      </Heading>
                      {onRowClick ? (
                        <button
                          type="button"
                          className="tr-tcards__hit"
                          aria-labelledby={titleId}
                          onClick={() => onRowClick(row)}
                        />
                      ) : null}
                    </div>
                    <dl className="tr-tcards__list">
                      {others.map((c) => (
                        <div key={c.key} className="tr-tcards__item">
                          <dt>{c.header}</dt>
                          <dd {...cellData(c)}>{c.render(row)}</dd>
                        </div>
                      ))}
                    </dl>
                    {onRowClick ? (
                      <Icon icon={ChevronRightIcon} size={18} className="tr-tcards__chev" />
                    ) : null}
                  </li>
                );
              })}
        </ul>
      </>,
    );
  }

  // A second flagged column is ignored: two row headers name the row twice.
  const headerKey = columns.find((c) => c.rowHeader)?.key;
  const openOnKey = (row: T) => (event: KeyboardEvent<HTMLTableRowElement>) => {
    if ((event.key !== "Enter" && event.key !== " ") || fromControl(event)) return;
    event.preventDefault();
    onRowClick?.(row);
  };
  const openOnClick = (row: T) => (event: MouseEvent<HTMLTableRowElement>) => {
    if (!fromControl(event)) onRowClick?.(row);
  };
  return frame(
    <table className="tr-table" aria-busy={loading === true ? true : undefined}>
      <caption className={captionVisible ? undefined : "tr-vh"}>{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              data-align={c.align}
              style={c.width ? { width: c.width } : undefined}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {loading
          ? SKELETON_ROWS.map((i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} {...cellData(c)}>
                    <span className="tr-table__skeleton" />
                  </td>
                ))}
              </tr>
            ))
          : rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  data-clickable={onRowClick ? "true" : undefined}
                  data-tone={rowTone?.(row)}
                  aria-current={selectedKey === key ? "true" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? openOnClick(row) : undefined}
                  onKeyDown={onRowClick ? openOnKey(row) : undefined}
                >
                  {columns.map((c, i) => {
                    const Cell = c.key === headerKey ? "th" : "td";
                    return (
                      <Cell key={c.key} scope={Cell === "th" ? "row" : undefined} {...cellData(c)}>
                        {c.render(row)}
                        {onRowClick && i === columns.length - 1 ? (
                          <Icon icon={ChevronRightIcon} size={18} className="tr-table__chev" />
                        ) : null}
                      </Cell>
                    );
                  })}
                </tr>
              );
            })}
      </tbody>
    </table>,
  );
}
