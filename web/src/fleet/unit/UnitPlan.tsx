import type { Unit } from "../../api/units";
import { AxleDiagram } from "../../ui/AxleDiagram";
import { diagramUnit } from "./unit.view";

// The unit in plan view, drawn entirely from its positions, so a superlink
// and a light vehicle run the same code (a fleet's axle library is tenant
// data, FR-VEH-002). Occupancy is text, never colour alone (NFR-USE-009).
export function UnitPlan({
  unit,
  selectedId,
  onSelect,
}: {
  unit: Unit;
  selectedId: string | null;
  onSelect: (positionId: string) => void;
}) {
  return (
    <AxleDiagram
      className="unit-plan"
      role="group"
      aria-label="Unit plan view"
      units={[diagramUnit(unit)]}
      // "" rather than null: every tile is a toggle, so with nothing picked
      // each still states aria-pressed="false".
      selectedId={selectedId ?? ""}
      onSelect={(position) => onSelect(position.id)}
    />
  );
}
