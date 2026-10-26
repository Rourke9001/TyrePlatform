import { Fragment, type HTMLAttributes } from "react";

import { cx } from "./cx";
import { TyreTile, type Condition } from "./TyreTile";
import "./AxleDiagram.css";

export interface DiagramPosition {
  // Unique across the whole diagram. Position ids repeat across
  // same-configuration units on a rig, so capture passes its cell key here
  // and the position id as dataPositionId (BR-VEH-003).
  id: string;
  // The tile's number, as the caller shows it (BR-VEH-001, FR-VEH-034).
  label: string;
  valueText?: string;
  badgeText?: string;
  ariaLabel?: string;
  dataPositionId?: string;
  condition?: Condition;
  empty?: boolean;
  active?: boolean;
}

export interface DiagramAxle {
  id: string;
  // A short name on the beam, shown only when given.
  label?: string;
  // Left to right in plan view, nose up (BR-VEH-001). Drawn in this order.
  positions: readonly DiagramPosition[];
}

export interface DiagramUnit {
  id: string;
  // The unit's identity in the caller's words. Two units of one
  // configuration share their description, never their heading (BR-VEH-003).
  unitHeading: string;
  description?: string;
  // Draws the hitch above this unit. A group that only carries spares is
  // not coupled to the unit before it (FR-INS-060).
  coupled?: boolean;
  axles: readonly DiagramAxle[];
  spares?: readonly DiagramPosition[];
}

export interface AxleDiagramProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onSelect"
> {
  // Drawn in the order given: the caller orders the walk.
  units: readonly DiagramUnit[];
  selectedId?: string;
  onSelect?: (position: DiagramPosition, unit: DiagramUnit) => void;
  frontLabel?: string;
  sideLabels?: { left: string; right: string };
  couplingLabel?: string;
  sparesLabel?: string;
}

// TODO(TYRE-447): these glyphs move to src/ui/icons/ when lane A's icon modules land.
function Glyph({ d }: { d: readonly string[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

const ARROW_UP = ["M12 19V5M6 11l6-6 6 6"];
const LINK = [
  "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1",
  "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
];

// Plan view, nose up: the frame BR-VEH-001 numbers positions in, so every
// screen shows a vehicle the same way round.
export function AxleDiagram({
  units,
  selectedId,
  onSelect,
  frontLabel,
  sideLabels,
  couplingLabel,
  sparesLabel,
  className,
  ...rest
}: AxleDiagramProps) {
  const tile = (p: DiagramPosition, u: DiagramUnit) => (
    <TyreTile
      key={p.id}
      numberText={p.label}
      valueText={p.valueText}
      badgeText={p.badgeText}
      condition={p.condition}
      ariaLabel={p.ariaLabel}
      empty={p.empty}
      active={p.active}
      selected={selectedId !== undefined ? selectedId === p.id : undefined}
      onClick={onSelect ? () => onSelect(p, u) : undefined}
      data-position-id={p.dataPositionId}
    />
  );
  return (
    <div {...rest} className={cx("tr-axles", className)}>
      {frontLabel ? (
        <div className="tr-axles__front">
          <Glyph d={ARROW_UP} />
          {frontLabel}
        </div>
      ) : null}
      {sideLabels ? (
        <div className="tr-axles__sides" aria-hidden="true">
          <span>{sideLabels.left}</span>
          <span>{sideLabels.right}</span>
        </div>
      ) : null}
      {units.map((u) => (
        <Fragment key={u.id}>
          {u.coupled ? (
            <div className="tr-axles__hitch" aria-hidden="true">
              <Glyph d={LINK} />
              {couplingLabel}
            </div>
          ) : null}
          <div className="tr-unit">
            <p className="tr-unit__head">
              <span className="tr-unit__name">{u.unitHeading}</span>
              {u.description ? (
                <>
                  {" "}
                  <span className="tr-unit__meta">{u.description}</span>
                </>
              ) : null}
            </p>
            {u.axles.map((a) => {
              const half = Math.ceil(a.positions.length / 2);
              return (
                <div key={a.id} className="tr-axle">
                  <div className="tr-axle__side tr-axle__side--left">
                    {a.positions.slice(0, half).map((p) => tile(p, u))}
                  </div>
                  <div className="tr-axle__beam">
                    {a.label ? (
                      <span className="tr-axle__label" aria-hidden="true">
                        {a.label}
                      </span>
                    ) : null}
                  </div>
                  <div className="tr-axle__side tr-axle__side--right">
                    {a.positions.slice(half).map((p) => tile(p, u))}
                  </div>
                </div>
              );
            })}
            {u.spares && u.spares.length > 0 ? (
              <div className="tr-spares">
                {sparesLabel ? <span className="tr-spares__label">{sparesLabel}</span> : null}
                {u.spares.map((p) => tile(p, u))}
              </div>
            ) : null}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
