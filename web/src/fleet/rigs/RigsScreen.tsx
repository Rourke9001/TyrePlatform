import { useCan } from "../../auth/actorContext";
import { RigForm } from "./RigForm";
import { RigList } from "./RigList";
import "../fleet.css";

// D5: the whole register on one screen. The form renders only for a
// controller who can write it (ManageAssignments, U2) — the route itself
// gates the read at ViewFleet, so the list below always renders.
export function RigsScreen() {
  const canAssign = useCan("ManageAssignments");

  return (
    <section aria-labelledby="rigs-heading" className="rigs">
      <h1 className="page-title" id="rigs-heading">
        Rigs
      </h1>
      {canAssign && <RigForm />}
      <RigList />
    </section>
  );
}
