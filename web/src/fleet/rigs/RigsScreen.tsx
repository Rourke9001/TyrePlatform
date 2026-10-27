import { useCan } from "../../auth/actorContext";
import { PageHeader } from "../../ui/PageHeader";
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
    <section aria-labelledby="rigs-heading" className="fleet-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader title={<span id="rigs-heading">Rigs</span>} />
      <ReportedDifferences />
      {canAssign && <RigForm />}
      <RigList />
    </section>
  );
}
