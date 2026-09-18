import { useCan } from "../../auth/actorContext";
import { ReportedDifferences } from "./ReportedDifferences";
import { RigForm } from "./RigForm";
import { RigList } from "./RigList";
import "../fleet.css";

// D5: the whole register on one screen. The write form renders only for
// ManageAssignments (U2); the read gates at ViewFleet. Reported differences
// come first since acting on one changes the rigs listed underneath
// (TYRE-75).
export function RigsScreen() {
  const canAssign = useCan("ManageAssignments");

  return (
    <section aria-labelledby="rigs-heading" className="rigs">
      <h1 className="page-title" id="rigs-heading">
        Rigs
      </h1>
      <ReportedDifferences />
      {canAssign && <RigForm />}
      <RigList />
    </section>
  );
}
