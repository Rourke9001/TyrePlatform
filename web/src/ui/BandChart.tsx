import { Fragment, useId, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

import { formatCount, formatPct, plural } from "../format/numbers";
import { bandFallback, bandFill } from "./bandFill";
import { cx } from "./cx";
import { usePhone } from "./useMediaQuery";
import "./BandChart.css";

export interface Band {
  // Written from the band's bounds by the caller, never from bandLabel
  // (U40, TYRE-270). Bands come shallowest first.
  label: string;
  count: number;
  // The wire's share of the group; this rounds it for display only.
  pctOfGroup: number;
}

// Rule 5: a limit is tenant configuration, so it is drawn only when the
// caller passes one, with its own words. The dashboard's wire has none.
type Limit =
  { limitBefore?: undefined; limitLabel?: undefined } | { limitBefore: number; limitLabel: string };

export type BandChartProps = Omit<HTMLAttributes<HTMLElement>, "title"> &
  Limit & {
    title: string;
    bands: Band[];
    empty?: ReactNode;
  };

function describe(band: Band): string {
  return `${band.label}: ${plural(band.count, "tyre", "tyres")}, ${formatPct(band.pctOfGroup)}`;
}

// FR-DSH-008. One ordinal series, so no legend: the title names it and each
// row names its band. Each row's aria-label and the table behind the
// disclosure are the accessible and printable forms.
export function BandChart({
  title,
  bands,
  limitBefore,
  limitLabel,
  empty = "No tyres in any band.",
  className,
  ...rest
}: BandChartProps) {
  const titleId = useId();
  const phone = usePhone();
  const max = Math.max(0, ...bands.map((b) => b.count));
  if (max === 0) return <p className="tr-bands__empty">{empty}</p>;

  return (
    <figure
      className={cx("tr-bands", className)}
      aria-labelledby={titleId}
      // Below breakpoint.phone a label takes its own line over its bar
      // (TYRE-238 comment 12938).
      data-form={phone ? "rows" : "inline"}
      {...rest}
    >
      <figcaption id={titleId} className="tr-bands__title">
        {title}
      </figcaption>
      <div className="tr-bands__plot">
        {bands.map((band, i) => {
          const atLimit = limitBefore !== undefined && i < limitBefore;
          // U46 up to five bands and U56 above, with the nearest stop for a
          // browser without color-mix; the ordinal is the band's place.
          const paint = {
            width: `${(band.count * 100) / max}%`,
            "--tr-band-fill": bandFill(i + 1, bands.length),
            "--tr-band-fallback": bandFallback(i + 1, bands.length),
          } as CSSProperties;
          return (
            <Fragment key={`${i}-${band.label}`}>
              <div
                className="tr-bands__row"
                role="img"
                aria-label={describe(band)}
                data-limit={atLimit ? "true" : undefined}
              >
                <span className="tr-bands__label">{band.label}</span>
                <span className="tr-bands__track">
                  <span className="tr-bands__bar" style={paint} />
                </span>
                <span className="tr-bands__val">
                  {formatCount(band.count)} <span>{formatPct(band.pctOfGroup)}</span>
                </span>
              </div>
              {limitBefore !== undefined && i === limitBefore - 1 ? (
                <p className="tr-bands__limit">{limitLabel}</p>
              ) : null}
            </Fragment>
          );
        })}
      </div>
      <details className="tr-bands__table">
        <summary>Show as table</summary>
        <table aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">Band</th>
              <th scope="col" data-align="right">
                Tyres
              </th>
              <th scope="col" data-align="right">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {bands.map((band, i) => (
              <tr key={`${i}-${band.label}`}>
                <td>{band.label}</td>
                <td data-align="right">{formatCount(band.count)}</td>
                <td data-align="right">{formatPct(band.pctOfGroup)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
