import type { KeyboardEvent } from "react";

import type { UnitPosition } from "../../api/units";

// The vehicle in plan view, drawn from the unit's own positions: axles left
// to right, LEFT above the chassis line and RIGHT below it, OUTER further
// from the line than INNER, spares in their own column beside axle 1. Every
// coordinate is derived from the array, so a superlink and a light vehicle
// are the same code — a fleet's axle library is tenant data (FR-VEH-002) and
// a layout that assumed three axles would be wrong for most of it.
//
// Occupancy is stated in text, never by colour alone (NFR-USE-009): each
// position carries its code and either its tyre's display code or the word
// "empty", and the selected one is marked by aria-pressed and a heavier
// outline rather than a fill.

const POS_W = 58;
const POS_H = 24;
const SLOT_GAP = 4;
// Half the gap the chassis line is drawn in, so the innermost slot clears it.
const BEAM_GAP = 15;
const AXLE_PITCH = POS_W + 26;
const PAD = 6;
// Two slots deep is app.axle_slot's maximum (OUTER/INNER), so the drawing's
// height is fixed even though its width is not.
const HALF_H = BEAM_GAP + 2 * POS_H + SLOT_GAP;
const HEIGHT = 2 * HALF_H;
const CENTRE_Y = HALF_H;

// How far from the chassis line a slot sits, in whole position heights.
function depthOf(slot: string | null): number {
  return slot === "OUTER" ? 2 : 1;
}

function topOf(position: UnitPosition): number {
  const depth = depthOf(position.slot);
  // RIGHT is the only side drawn below the line; a position that records no
  // side at all is a spare, which never reaches this function.
  if (position.side === "RIGHT") {
    return CENTRE_Y + BEAM_GAP + (depth - 1) * (POS_H + SLOT_GAP);
  }
  return CENTRE_Y - BEAM_GAP - depth * POS_H - (depth - 1) * SLOT_GAP;
}

function occupantOf(position: UnitPosition): string {
  return position.fitment?.displayCode ?? "empty";
}

export function UnitPlan({
  positions,
  selectedId,
  onSelect,
}: {
  positions: UnitPosition[];
  selectedId: string | null;
  onSelect: (positionId: string) => void;
}) {
  const spares = positions.filter((p) => p.isSpare);
  const mounted = positions.filter((p) => !p.isSpare);

  // Axle numbers ascending, whatever the read happened to contain: a unit
  // with axles 1 and 3 (a member of a combination read on its own) must
  // still draw two axles side by side rather than a gap where axle 2 is not.
  const axleNumbers = [...new Set(mounted.map((p) => p.axleNumber ?? 0))].sort((a, b) => a - b);

  const spareColumn = spares.length > 0 ? POS_W + 20 : 0;
  const width = PAD * 2 + spareColumn + Math.max(axleNumbers.length, 1) * AXLE_PITCH;

  function axleX(index: number): number {
    return PAD + spareColumn + index * AXLE_PITCH;
  }

  return (
    <svg
      className="unit-plan"
      viewBox={`0 0 ${width} ${HEIGHT}`}
      width={width}
      height={HEIGHT}
      // group, not img: an img's descendants are presentational, which would
      // take every position button out of the accessibility tree.
      role="group"
      aria-label="Unit plan view"
    >
      {axleNumbers.length > 0 && (
        <line
          className="unit-plan-chassis"
          x1={axleX(0)}
          y1={CENTRE_Y}
          x2={axleX(axleNumbers.length - 1) + POS_W}
          y2={CENTRE_Y}
        />
      )}

      {axleNumbers.map((axleNumber, index) => (
        <g key={axleNumber} role="group" aria-label={`Axle ${axleNumber}`}>
          <line
            className="unit-plan-beam"
            x1={axleX(index) + POS_W / 2}
            y1={CENTRE_Y - HALF_H + PAD}
            x2={axleX(index) + POS_W / 2}
            y2={CENTRE_Y + HALF_H - PAD}
          />
          {mounted
            .filter((p) => (p.axleNumber ?? 0) === axleNumber)
            .sort((a, b) => a.sequence - b.sequence)
            .map((position) => (
              <PlanPosition
                key={position.id}
                position={position}
                x={axleX(index)}
                y={topOf(position)}
                selected={position.id === selectedId}
                onSelect={onSelect}
              />
            ))}
        </g>
      ))}

      {spares.length > 0 && (
        <g role="group" aria-label="Spares">
          {spares.map((position, i) => (
            <PlanPosition
              key={position.id}
              position={position}
              x={PAD}
              y={CENTRE_Y - POS_H / 2 + i * (POS_H + SLOT_GAP)}
              selected={position.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </g>
      )}
    </svg>
  );
}

function PlanPosition({
  position,
  x,
  y,
  selected,
  onSelect,
}: {
  position: UnitPosition;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (positionId: string) => void;
}) {
  // A <g> carries no default activation behaviour, so the keys a button
  // answers to have to be spelled out. Space is prevented from scrolling the
  // page under the drawing.
  function onKeyDown(e: KeyboardEvent<SVGGElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onSelect(position.id);
  }

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`Position ${position.code}: ${occupantOf(position)}`}
      aria-pressed={selected}
      // The e2e specs reach a position by its id rather than its wording:
      // CR-010 keeps requirement ids out of user-facing text, so a spec keyed
      // on the friendly name would fail on the next copy edit
      // (web/CLAUDE.md).
      data-position-id={position.id}
      className={selected ? "unit-plan-pos unit-plan-pos--selected" : "unit-plan-pos"}
      onClick={() => onSelect(position.id)}
      onKeyDown={onKeyDown}
    >
      <rect x={x} y={y} width={POS_W} height={POS_H} rx="4" />
      <text className="unit-plan-code" x={x + POS_W / 2} y={y + 10}>
        {position.code}
      </text>
      <text className="unit-plan-occupant" x={x + POS_W / 2} y={y + 20}>
        {occupantOf(position)}
      </text>
    </g>
  );
}
