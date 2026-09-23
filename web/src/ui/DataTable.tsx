import type { ReactNode } from "react";

import { usePhone } from "./useMediaQuery";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  // A money figure never stands without its basis (TYRE-176, ADR-0010);
  // the column that carries it is styled as the figure's footnote.
  basis?: boolean;
  cell: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: ReactNode;
  loading?: boolean;
  // The phone form heads each card, and that heading nests under the one
  // the table sits beneath: 3 below a Panel's h2, 2 for a page's own table.
  cardHeadingLevel?: 2 | 3 | 4;
}

const SKELETON_ROWS = [0, 1, 2, 3];

function cellClass<T>(column: Column<T>): string {
  return [column.align === "right" ? "cell-right" : "cell-left", column.basis ? "cell-basis" : ""]
    .filter(Boolean)
    .join(" ");
}

// Loading keeps the frame, table or card list, so the layout does not jump;
// empty replaces it with the caller's words, since an empty table looks like
// a broken one. aria-busy on the frame marks the skeleton as not yet content.
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  loading = false,
  cardHeadingLevel = 3,
}: DataTableProps<T>) {
  const phone = usePhone();
  // NVDA and JAWS do not announce aria-busy, so the load is said in a status
  // line (WCAG 4.1.3). It is the first child in every form, so one live
  // region outlasts the switch from loading to rows or to empty.
  const status = (
    <p role="status" className="visually-hidden">
      {loading ? `Loading ${caption}` : ""}
    </p>
  );
  if (!loading && rows.length === 0) {
    return (
      <>
        {status}
        {empty}
      </>
    );
  }
  if (phone) {
    return (
      <>
        {status}
        <DataCards
          caption={caption}
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          loading={loading}
          headingLevel={cardHeadingLevel}
        />
      </>
    );
  }
  return (
    <>
      {status}
      <div className="data-table-wrap">
        <table className="data-table" aria-busy={loading || undefined}>
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cellClass(c)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? SKELETON_ROWS.map((i) => (
                  <tr key={i} className="data-table-skeleton">
                    {columns.map((c) => (
                      <td key={c.key} className={cellClass(c)}>
                        <span className="skeleton-block" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr key={rowKey(row)}>
                    {columns.map((c) => (
                      <td key={c.key} className={cellClass(c)}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface DataCardsProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading: boolean;
  headingLevel: 2 | 3 | 4;
}

// Below the phone breakpoint, one card per row (TYRE-238). The first column
// heads the card and every other column follows as a dt/dd pair, in order.
function DataCards<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  headingLevel,
}: DataCardsProps<T>) {
  const Heading = `h${headingLevel}` as const;
  const [first, ...rest] = columns;
  return (
    // role="list" because WebKit drops list semantics from a ul styled
    // list-style: none, and VoiceOver then reads no count.
    <ul className="data-cards" role="list" aria-label={caption} aria-busy={loading || undefined}>
      {loading
        ? SKELETON_ROWS.map((i) => (
            <li key={i} className="data-card data-card-skeleton">
              {/* A div, not a heading, since an empty heading is announced
                  with nothing after it. */}
              <div className="data-card-heading">
                <span className="skeleton-block" />
              </div>
              <CardFields columns={rest} value={() => <span className="skeleton-block" />} />
            </li>
          ))
        : rows.map((row) => (
            <li key={rowKey(row)} className="data-card">
              <Heading className="data-card-heading">{first.cell(row)}</Heading>
              <CardFields columns={rest} value={(c) => c.cell(row)} />
            </li>
          ))}
    </ul>
  );
}

function CardFields<T>({
  columns,
  value,
}: {
  columns: Column<T>[];
  value: (column: Column<T>) => ReactNode;
}) {
  return (
    <dl className="data-card-fields">
      {columns.map((c) => (
        <div key={c.key} className="data-card-field">
          <dt>{c.header}</dt>
          <dd className={cellClass(c)}>{value(c)}</dd>
        </div>
      ))}
    </dl>
  );
}
