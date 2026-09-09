import { useCan } from "../../auth/actorContext";
import { ReportedDifferences } from "./ReportedDifferences";
import { RigForm } from "./RigForm";
import { RigList } from "./RigList";
import "../fleet.css";

// D5: the whole register on one screen. The form renders only for a
// controller who can write it (ManageAssignments, U2). The route itself
// gates the read at ViewFleet, so the list below always renders. The reported
// differences come first: a report is about the rigs listed underneath, and
// acting on one changes them (TYRE-75).
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
