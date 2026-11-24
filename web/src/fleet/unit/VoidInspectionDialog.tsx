import { useState } from "react";

import type { InspectionUnit, UnitInspection } from "../../api/inspections";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { IconButton } from "../../ui/IconButton";
import { CloseIcon } from "../../ui/icons/Close";
import { TextArea } from "../../ui/TextArea";
import { RefusalAlert } from "../RefusalAlert";
import { useVoidInspection } from "./inspections.data";

// The server's own refusals, each shown as it reads: TY019 (already voided,
// or no reason), TY012 and not_found (gone, or outside the actor's depots).
const VOID_WORDING = {
  speakable: ["TY019", "TY012", "not_found"],
  forbidden: "Only a controller, depot manager or org admin can void an inspection.",
  fallback: "The void did not go through. Check your connection and try again.",
};

// FR-INS-012 and IR-UI-009: a void is confirmed with a reason, and the
// confirmation names the inspection and every unit it read. The form stops
// at 200 characters; the server's 200-byte cap stays the authority
// (inspections.go) and its refusal shows here.
export function VoidInspectionDialog({
  open,
  onClose,
  inspection,
  units,
  when,
  onVoided,
}: {
  open: boolean;
  onClose: () => void;
  inspection: UnitInspection;
  units: InspectionUnit[];
  // The caller's tenant-time text for the inspection (rule 6).
  when: string;
  onVoided: () => void;
}) {
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const write = useVoidInspection(inspection.inspectionId, onVoided);

  // Escape, Close and the backdrop leave it open while the write is pending.
  const close = () => {
    if (!write.isPending) onClose();
  };
  const confirm = () => {
    if (reason.trim() === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    write.submit(reason);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      tone="danger"
      title="Void this inspection?"
      actions={
        <>
          <Button variant="danger" disabled={write.isPending} onClick={confirm}>
            Void inspection
          </Button>
          <Button variant="ghost" disabled={write.isPending} onClick={close}>
            Keep it
          </Button>
          <IconButton label="Close" icon={CloseIcon} onClick={close} />
        </>
      }
    >
      <p className="void-dialog-line">{`The inspection of ${when} by ${inspection.driver.displayName}, which read:`}</p>
      <ul className="void-dialog-units">
        {units.map((u) => (
          <li key={u.fleetNumber}>{u.fleetNumber}</li>
        ))}
      </ul>
      <p className="void-dialog-line">
        It stays on record, marked voided. Its readings stop counting toward condition, exceptions,
        wear rates and values for every unit listed. This cannot be undone, and it does not ask for
        a new inspection: schedule one from the unit&apos;s page if one is needed.
      </p>
      <Field label="Reason" error={missing ? "Give a reason for the void." : undefined}>
        <TextArea
          value={reason}
          maxLength={200}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </Field>
      <RefusalAlert error={write.error} wording={VOID_WORDING} />
    </Dialog>
  );
}
