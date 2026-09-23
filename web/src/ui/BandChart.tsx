import { useId, useState, type ReactNode } from "react";

import { treadBandStep } from "../theme/tokens";
import { usePhone } from "./useMediaQuery";
import { bandRangeLabel, formatCount, formatPct } from "./vocabulary";

export interface BandDatum {
  bandOrdinal: number;
  lowerMm: number;
  upperExclusiveMm: number | null;
  tyreCount: number;
  pctOfGroup: number;
}

interface BandChartProps {
  title: string;
  bands: BandDatum[];
}

// Both forms in SVG user units, from the accepted dashboard mockup; the
// viewBox scales to the panel. Bars are at most 24 units thick, rounded 4
// at the data end and square at the baseline (dataviz, marks).
const COLUMNS = {
  width: 560,
  height: 250,
  plotTop: 30,
  plotBottom: 172,
  barMax: 24,
  countGap: 10,
  axisY: 194,
} as const;

// A row is the bound label on its own line above the bar. The longest bar
// stops at 240 of 300 so the count after it stays inside the viewBox.
const ROWS = {
  width: 300,
  pad: 6,
  pitch: 50,
  hit: 46,
  labelY: 14,
  barY: 22,
  bar: 16,
  barMax: 240,
  countGap: 8,
  countY: 35,
} as const;

const RADIUS = 4;

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function describeBand(b: BandDatum): string {
  return `${bandRangeLabel(b.lowerMm, b.upperExclusiveMm)}: ${plural(b.tyreCount, "tyre", "tyres")}, ${formatPct(b.pctOfGroup)}`;
}

// Five bound labels on one line collide even in a half-width panel at
// 1280, so the column's label takes two. Both shapes bandRangeLabel writes
// end in a two-word unit ("5 mm", "and over"), and the break goes before it,
// which keeps bandRangeLabel the one source of the words (U40).
function axisLines(label: string): [string, string] {
  const words = label.split(" ");
  return [words.slice(0, -2).join(" "), words.slice(-2).join(" ")];
}

function columnSlot(count: number): number {
  return COLUMNS.width / count;
}

function rowTop(i: number): number {
  return ROWS.pad + ROWS.pitch * i;
}

function rowsHeight(count: number): number {
  return ROWS.pad * 2 + ROWS.pitch * count;
}

function percent(part: number, whole: number): string {
  return `${(part / whole) * 100}%`;
}

type BandIndexHandler = (index: number | null) => void;

interface BandMarkProps {
  band: BandDatum;
  index: number;
  hit: { x: number; y: number; width: number; height: number };
  onFocusBand: BandIndexHandler;
  onHoverBand: BandIndexHandler;
  children: ReactNode;
}

// One band in either form. The hit target is the whole slot or row, bigger
// than the bar (dataviz, interaction). Focus and hover are tracked
// separately: blur clears only the keyboard state and mouseleave only the
// pointer state, so a mouse crossing and leaving a band never drops a
// keyboard user's tooltip (TYRE-238 review).
function BandMark({ band, index, hit, onFocusBand, onHoverBand, children }: BandMarkProps) {
  return (
    <g
      role="img"
      aria-label={describeBand(band)}
      tabIndex={0}
      className="band-chart-bar"
      onFocus={() => onFocusBand(index)}
      onBlur={() => onFocusBand(null)}
      onMouseEnter={() => onHoverBand(index)}
      onMouseLeave={() => onHoverBand(null)}
      // Every browser gives an SVG group focus on mousedown, so a clicked
      // band would outlive the pointer leaving and strand its tooltip
      // (activeIndex falls back to focused); nothing here is text to
      // select, so suppressing the pointer's default focus costs nothing
      // (TYRE-238 review).
      onMouseDown={(e) => e.preventDefault()}
    >
      <rect {...hit} fill="transparent" />
      {children}
    </g>
  );
}

interface FormProps {
  bands: BandDatum[];
  max: number;
  label: string;
  onFocusBand: BandIndexHandler;
  onHoverBand: BandIndexHandler;
}

function BandColumns({ bands, max, label, onFocusBand, onHoverBand }: FormProps) {
  const slot = columnSlot(bands.length);
  const barWidth = Math.min(COLUMNS.barMax, slot * 0.6);
  const plotHeight = COLUMNS.plotBottom - COLUMNS.plotTop;
  return (
    <svg
      viewBox={`0 0 ${COLUMNS.width} ${COLUMNS.height}`}
      className="band-chart-svg"
      data-form="columns"
      role="group"
      aria-label={label}
    >
      <line
        x1="0"
        y1={COLUMNS.plotBottom}
        x2={COLUMNS.width}
        y2={COLUMNS.plotBottom}
        className="band-chart-baseline"
      />
      {bands.map((b, i) => {
        const height = (b.tyreCount / max) * plotHeight;
        const x = slot * i + (slot - barWidth) / 2;
        const y = COLUMNS.plotBottom - height;
        const centre = slot * i + slot / 2;
        const r = Math.min(RADIUS, height / 2);
        const [first, second] = axisLines(bandRangeLabel(b.lowerMm, b.upperExclusiveMm));
        // Rounded at the data end only: a path, since rect's rx rounds
        // both ends.
        const d = [
          `M ${x} ${COLUMNS.plotBottom}`,
          `V ${y + r}`,
          `Q ${x} ${y} ${x + r} ${y}`,
          `H ${x + barWidth - r}`,
          `Q ${x + barWidth} ${y} ${x + barWidth} ${y + r}`,
          `V ${COLUMNS.plotBottom}`,
          "Z",
        ].join(" ");
        return (
          <BandMark
            key={b.bandOrdinal}
            band={b}
            index={i}
            hit={{ x: slot * i, y: COLUMNS.plotTop, width: slot, height: plotHeight }}
            onFocusBand={onFocusBand}
            onHoverBand={onHoverBand}
          >
            {/* style, not the fill attribute: SVG's fill presentation
                attribute does not take var() reliably (TYRE-238 review). */}
            <path
              d={d}
              style={{ fill: `var(--band-${treadBandStep(b.bandOrdinal, bands.length)})` }}
            />
            <text
              x={centre}
              y={y - COLUMNS.countGap}
              textAnchor="middle"
              className="band-chart-count"
            >
              {formatCount(b.tyreCount)}
            </text>
            <text x={centre} y={COLUMNS.axisY} textAnchor="middle" className="band-chart-axis">
              {first}
              <tspan x={centre} dy="1.2em">
                {second}
              </tspan>
            </text>
          </BandMark>
        );
      })}
    </svg>
  );
}

// Below the phone breakpoint five bound labels cannot sit side by side,
// and hiding one is not an option (U40), so each band gets a row and its
// label a full line (owner, TYRE-238 comment 12938).
function BandRows({ bands, max, label, onFocusBand, onHoverBand }: FormProps) {
  const lastTop = rowTop(bands.length - 1);
  return (
    <svg
      viewBox={`0 0 ${ROWS.width} ${rowsHeight(bands.length)}`}
      className="band-chart-svg"
      data-form="rows"
      role="group"
      aria-label={label}
    >
      <line
        x1="0.5"
        y1={ROWS.pad + ROWS.barY - 2}
        x2="0.5"
        y2={lastTop + ROWS.barY + ROWS.bar + 2}
        className="band-chart-baseline"
      />
      {bands.map((b, i) => {
        const top = rowTop(i);
        const y = top + ROWS.barY;
        const w = (b.tyreCount / max) * ROWS.barMax;
        const r = Math.min(RADIUS, w / 2);
        const d = [
          `M 0 ${y}`,
          `H ${w - r}`,
          `Q ${w} ${y} ${w} ${y + r}`,
          `V ${y + ROWS.bar - r}`,
          `Q ${w} ${y + ROWS.bar} ${w - r} ${y + ROWS.bar}`,
          "H 0",
          "Z",
        ].join(" ");
        return (
          <BandMark
            key={b.bandOrdinal}
            band={b}
            index={i}
            hit={{ x: 0, y: top, width: ROWS.width, height: ROWS.hit }}
            onFocusBand={onFocusBand}
            onHoverBand={onHoverBand}
          >
            <text x="0" y={top + ROWS.labelY} className="band-chart-axis">
              {bandRangeLabel(b.lowerMm, b.upperExclusiveMm)}
            </text>
            <path
              d={d}
              style={{ fill: `var(--band-${treadBandStep(b.bandOrdinal, bands.length)})` }}
            />
            <text x={w + ROWS.countGap} y={top + ROWS.countY} className="band-chart-count">
              {formatCount(b.tyreCount)}
            </text>
          </BandMark>
        );
      })}
    </svg>
  );
}

interface BandTooltipProps {
  band: BandDatum;
  index: number;
  count: number;
  phone: boolean;
}

// Above its column on a desktop, with the first and last pulled back
// inside the plot by data-edge; beside its row on a phone.
function BandTooltip({ band, index, count, phone }: BandTooltipProps) {
  const edge = index === 0 ? "start" : index === count - 1 ? "end" : undefined;
  return (
    <div
      role="tooltip"
      className={phone ? "band-chart-tooltip band-chart-tooltip-beside" : "band-chart-tooltip"}
      data-edge={phone ? undefined : edge}
      style={
        phone
          ? { top: percent(rowTop(index), rowsHeight(count)) }
          : { left: percent(columnSlot(count) * (index + 0.5), COLUMNS.width) }
      }
    >
      <strong>{bandRangeLabel(band.lowerMm, band.upperExclusiveMm)}</strong>
      <br />
      {plural(band.tyreCount, "tyre", "tyres")}, {formatPct(band.pctOfGroup)}
    </div>
  );
}

// FR-DSH-008. One ordinal series, so no legend box: the title names it and
// each band's label names the band (dataviz, labels and legend). The
// tooltip is a convenience; the aria-label on each band and the table
// behind the disclosure are the accessible and printable forms.
export function BandChart({ title, bands }: BandChartProps) {
  const titleId = useId();
  const phone = usePhone();
  const [focused, setFocused] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...bands.map((b) => b.tyreCount), 0);

  if (max === 0) {
    return <p className="band-chart-empty">No tyres in any band.</p>;
  }

  // The pointer wins while it is over a band; leaving it falls back to
  // whichever band still has keyboard focus, so a mouse crossing the chart
  // never strands a keyboard user's tooltip on null (TYRE-238 review).
  const activeIndex = hovered ?? focused;
  const active: BandDatum | undefined = activeIndex === null ? undefined : bands[activeIndex];
  const formProps: FormProps = {
    bands,
    max,
    label: `${title}, ${plural(bands.length, "band", "bands")}`,
    onFocusBand: setFocused,
    onHoverBand: setHovered,
  };

  return (
    <figure className="band-chart" aria-labelledby={titleId}>
      <figcaption id={titleId} className="band-chart-title">
        {title}
      </figcaption>
      <div className="band-chart-plot">
        {phone ? <BandRows {...formProps} /> : <BandColumns {...formProps} />}
        {active !== undefined && activeIndex !== null && (
          <BandTooltip band={active} index={activeIndex} count={bands.length} phone={phone} />
        )}
      </div>
      <details className="band-chart-table">
        <summary>Show as table</summary>
        <table aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">Band</th>
              <th scope="col" className="cell-right">
                Tyres
              </th>
              <th scope="col" className="cell-right">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.bandOrdinal}>
                <td>{bandRangeLabel(b.lowerMm, b.upperExclusiveMm)}</td>
                <td className="cell-right">{formatCount(b.tyreCount)}</td>
                <td className="cell-right">{formatPct(b.pctOfGroup)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
