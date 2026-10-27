import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { fetchTyres } from "../../api/tyres";
import { fitTyre, type NewFitment, type Unit, type UnitPosition } from "../../api/units";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { TextInput } from "../../ui/TextInput";
import { RefusalAlert } from "../RefusalAlert";
import { useFormMutation } from "../useFormMutation";
import type { ActedSummary } from "./PositionPanel";
import { byNaturalCode } from "./naturalOrder";
import { ODOMETER_REQUIRED, odometerRefusal, readOdometer } from "./odometer";
import { useUnitLabels } from "../../units/units";
import { openFitmentsKey, tyresKey, unitFitmentsKey, unitKey } from "./queryKeys";
import { MOUNT_ORIENTATIONS, ORIENTATION_UNKNOWN } from "./vocabulary";

// A fit refuses for different reasons than a removal: app.fit_tyre reaches
// TY009/TY012/TY014 plus two occupancy conflicts (fitments.go), where
// app.remove_tyre reaches TY009 alone.
const FIT_WORDING = {
  speakable: ["TY009", "TY012", "TY014", "position_occupied", "tyre_already_fitted"],
  forbidden: "You do not have permission to fit a tyre.",
  fallback: "The tyre could not be fitted. Try again, or call support if it keeps happening.",
};

// The empty-position form. Rendered only while position.fitment is null
// (D7); a successful fit turns the position occupied and PositionPanel
// swaps this out for RemoveForm, so the confirmation and any warnings this
// write raised are handed up rather than kept here.
export function FitForm({
  unit,
  position,
  onActed,
  onRefused,
}: {
  unit: Unit;
  position: UnitPosition;
  onActed: (summary: ActedSummary) => void;
  onRefused: (message: string) => void;
}) {
  const tenantKey = getDevTenantId() ?? "default";
  const labels = useUnitLabels();

  const [tyreId, setTyreId] = useState("");
  const [fitTread, setFitTread] = useState("");
  // D13: an unasserted orientation is recorded UNKNOWN, never guessed.
  // mountOrientation is required on the wire and written to an immutable
  // row (rule 3), so defaulting to MARK_OUTBOARD would record a fact
  // nobody asserted.
  const [orientation, setOrientation] = useState<string>(ORIENTATION_UNKNOWN);
  const [fitOdometer, setFitOdometer] = useState("");
  // The display code chosen at submit, read again in onSuccess: the picker
  // clears before the fitment id this produced is known, so the code has
  // to survive in something other than the field it came from.
  const submittedCode = useRef("");

  // GET /api/tyres takes no state parameter, so the register is read whole
  // and narrowed to stock below; the key segment names what is actually
  // cached.
  const stock = useQuery({
    queryKey: [...tyresKey(tenantKey), "register"],
    queryFn: () => fetchTyres(),
  });

  const invalidate = [
    unitKey(unit.id),
    unitFitmentsKey(unit.id),
    tyresKey(tenantKey),
    openFitmentsKey(tenantKey),
  ];

  const fit = useFormMutation({
    mutate: (vars: NewFitment) => fitTyre(unit.id, vars),
    invalidate,
    onSuccess: (result) => {
      onActed({
        kind: "fit",
        code: submittedCode.current,
        fitmentId: result.fitmentId,
        warnings: result.warnings,
      });
      setTyreId("");
      setFitTread("");
      setFitOdometer("");
    },
  });

  const inStock = (stock.data ?? [])
    .filter((t) => t.state === "IN_STOCK")
    .sort((a, b) => byNaturalCode(a.displayCode, b.displayCode));

  function submitFit(e: FormEvent) {
    e.preventDefault();
    if (tyreId === "" || fitTread.trim() === "") return;
    if (unit.hasOdometer && fitOdometer.trim() === "") {
      onRefused(ODOMETER_REQUIRED);
      return;
    }
    const odometer = readOdometer(unit.hasOdometer ? fitOdometer : "");
    if (!odometer.ok) {
      onRefused(odometerRefusal(labels));
      return;
    }
    onRefused("");
    submittedCode.current = inStock.find((t) => t.id === tyreId)?.displayCode ?? "";
    fit.submit({
      tyreId,
      positionId: position.id,
      treadMm: fitTread.trim(),
      mountOrientation: orientation,
      odometer: odometer.value,
    });
  }

  return (
    <form className="unit-form" onSubmit={submitFit}>
      {stock.isError ? (
        <Banner
          tone="critical"
          title={<h3 className="unit-banner-heading">Tyres didn&apos;t load</h3>}
          action={
            <Button variant="primary" onClick={() => void stock.refetch()}>
              Retry
            </Button>
          }
        >
          <p className="unit-banner-body">
            The server could not be reached. Check your connection, then retry.
          </p>
        </Banner>
      ) : (
        <Field label="Tyre">
          {/* Pending, the one option says so and cannot be chosen; loaded,
              "Choose…" is an ordinary option again. */}
          <Select
            id={`fit-tyre-${position.id}`}
            value={tyreId}
            onChange={(e) => setTyreId(e.target.value)}
            placeholder={stock.isPending ? "Loading…" : undefined}
            options={
              stock.isPending
                ? []
                : [
                    { value: "", label: "Choose…" },
                    ...inStock.map((t) => ({ value: t.id, label: t.displayCode })),
                  ]
            }
          />
        </Field>
      )}

      <Field label="Tread (mm)">
        <TextInput
          id={`fit-tread-${position.id}`}
          inputMode="decimal"
          mono
          value={fitTread}
          onChange={(e) => setFitTread(e.target.value)}
          required
        />
      </Field>

      <div role="radiogroup" aria-label="Mount orientation" className="unit-radios">
        {MOUNT_ORIENTATIONS.map((o) => (
          <label key={o.value}>
            <input
              type="radio"
              name={`orientation-${position.id}`}
              value={o.value}
              checked={orientation === o.value}
              onChange={() => setOrientation(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>

      {/* FR-FIT-002: a unit that has an odometer needs the reading, and
          the trigger that enforces it (000025) refuses the whole write.
          Asking for it here costs a tap; leaving it optional costs a
          refusal the controller has to read and retry. */}
      {unit.hasOdometer && (
        <Field label="Odometer">
          <TextInput
            id={`fit-odometer-${position.id}`}
            inputMode="numeric"
            mono
            value={fitOdometer}
            onChange={(e) => setFitOdometer(e.target.value)}
            required
          />
        </Field>
      )}

      <Button variant="primary" type="submit" disabled={tyreId === "" || fit.isPending}>
        {fit.isPending ? "Fitting…" : "Fit tyre"}
      </Button>

      <RefusalAlert error={fit.error} wording={FIT_WORDING} />
    </form>
  );
}
