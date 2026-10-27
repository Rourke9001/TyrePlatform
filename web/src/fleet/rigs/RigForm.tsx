import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createRig, fetchRigs, type NewRig } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { fetchVehicles } from "../../api/vehicles";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Field } from "../../ui/Field";
import { PlusIcon } from "../../ui/icons/Plus";
import { Select } from "../../ui/Select";
import { TextInput } from "../../ui/TextInput";
import { useFormMutation } from "../useFormMutation";
import { rigsKey, vehiclesKey } from "../unit/queryKeys";
import "../fleet.css";

// Refusals a controller can still hit after the client narrows the option
// lists (D2's kind/retirement/duplicate checks), plus the not-visible read,
// in case a second controller wins the race.
const CREATE_WORDING = {
  speakable: ["TY017", "TY012"],
  forbidden: "You do not have permission to set a rig.",
  fallback: "The rig could not be set. Retry.",
};

// U9: DISPOSED and INACTIVE are retired states; PARKED, WORKSHOP and
// OUT_OF_SERVICE only pause a unit's schedule and still couple.
const RETIRED = new Set(["DISPOSED", "INACTIVE"]);

interface TowedRow {
  vehicleId: string;
  descriptor: string;
}

// D5: a motive select, an ordered towed list with Add/Up/Down/Remove, and
// an effective-from date the browser never supplies (rule 6). What may
// actually couple is app.create_combination's alone (D2).
export function RigForm() {
  const tenantKey = getDevTenantId() ?? "default";

  const rigs = useQuery({ queryKey: rigsKey(tenantKey), queryFn: () => fetchRigs() });
  const vehicles = useQuery({ queryKey: vehiclesKey(tenantKey), queryFn: fetchVehicles });

  const [motiveId, setMotiveId] = useState("");
  const [towed, setTowed] = useState<TowedRow[]>([]);
  const [trailerPick, setTrailerPick] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");

  const create = useFormMutation({
    mutate: (body: NewRig) => createRig(body),
    invalidate: [rigsKey(tenantKey), vehiclesKey(tenantKey)],
    onSuccess: () => {
      setMotiveId("");
      setTowed([]);
      setTrailerPick("");
      setEffectiveOn("");
    },
  });

  // U5/INV-4: a unit already in an open rig cannot join another until that
  // one ends (D1.2), narrowed here so the option lists never offer a choice
  // the server would refuse.
  const inOpenRig = new Set(
    (rigs.data ?? [])
      .filter((r) => r.effectiveTo === null)
      .flatMap((r) => r.members.map((m) => m.vehicleId)),
  );

  const motiveOptions = (vehicles.data ?? []).filter(
    (v) =>
      v.unitKind !== null &&
      v.unitKind !== "TRAILER" &&
      !RETIRED.has(v.status) &&
      !inOpenRig.has(v.id),
  );

  const towedIds = new Set(towed.map((t) => t.vehicleId));
  const trailerOptions = (vehicles.data ?? []).filter(
    (v) =>
      v.unitKind === "TRAILER" &&
      !RETIRED.has(v.status) &&
      !inOpenRig.has(v.id) &&
      !towedIds.has(v.id),
  );

  function fleetNumberOf(vehicleId: string): string {
    return vehicles.data?.find((v) => v.id === vehicleId)?.fleetNumber ?? vehicleId;
  }

  function addTrailer() {
    if (trailerPick === "") return;
    setTowed([...towed, { vehicleId: trailerPick, descriptor: "" }]);
    setTrailerPick("");
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= towed.length) return;
    const next = [...towed];
    [next[index], next[target]] = [next[target], next[index]];
    setTowed(next);
  }

  function remove(index: number) {
    setTowed(towed.filter((_, i) => i !== index));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (motiveId === "" || towed.length === 0) return;
    const body: NewRig = {
      motiveVehicleId: motiveId,
      towed: towed.map((t) =>
        t.descriptor.trim() === ""
          ? { vehicleId: t.vehicleId }
          : { vehicleId: t.vehicleId, descriptor: t.descriptor.trim() },
      ),
    };
    // Never the browser's "today" (rule 6, lessons 2026-09-03): an empty
    // date omits effectiveOn entirely so the server resolves it in the
    // tenant's own zone (U8).
    if (effectiveOn.trim() !== "") {
      body.effectiveOn = effectiveOn;
    }
    create.submit(body);
  }

  return (
    <Card title="Set a rig">
      <div className="tr-stack">
        {vehicles.isError && (
          <Banner
            tone="critical"
            title="The unit list could not be loaded."
            action={<Button onClick={() => void vehicles.refetch()}>Retry</Button>}
          />
        )}
        <form className="tr-stack" onSubmit={submit}>
          <Field label="Motive unit" className="fleet-field-narrow">
            <Select
              id="rigMotive"
              value={motiveId}
              onChange={(e) => setMotiveId(e.target.value)}
              options={[
                { value: "", label: "Choose…" },
                ...motiveOptions.map((v) => ({ value: v.id, label: v.fleetNumber })),
              ]}
            />
          </Field>

          <p id="rig-towed-heading" className="fleet-subhead">
            Towed, in walk order
          </p>
          {towed.length > 0 && (
            <ul className="unit-rotate-rows fleet-towed" aria-labelledby="rig-towed-heading">
              {towed.map((row, index) => {
                const fleetNumber = fleetNumberOf(row.vehicleId);
                const atStart = index === 0;
                const atEnd = index === towed.length - 1;
                return (
                  <li key={row.vehicleId}>
                    <span className="fleet-towed__seq">{index + 1}</span>
                    <span className="fleet-towed__unit">{fleetNumber}</span>
                    <TextInput
                      aria-label={`Descriptor for ${fleetNumber}`}
                      placeholder="Descriptor"
                      value={row.descriptor}
                      onChange={(e) => {
                        const next = [...towed];
                        next[index] = { ...next[index], descriptor: e.target.value };
                        setTowed(next);
                      }}
                    />
                    {/* aria-disabled, not disabled: a boundary row stays in the
                        tab order so focus survives a reorder that lands it
                        there. move() already no-ops past either end. */}
                    <Button
                      variant="ghost"
                      aria-label={`Move ${fleetNumber} up`}
                      aria-disabled={atStart ? "true" : undefined}
                      onClick={() => move(index, -1)}
                    >
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Move ${fleetNumber} down`}
                      aria-disabled={atEnd ? "true" : undefined}
                      onClick={() => move(index, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${fleetNumber}`}
                      onClick={() => remove(index)}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="fleet-toolbar">
            <Field label="Trailer" className="fleet-field-narrow">
              <Select
                id="rigTrailer"
                value={trailerPick}
                onChange={(e) => setTrailerPick(e.target.value)}
                options={[
                  { value: "", label: "Choose…" },
                  ...trailerOptions.map((v) => ({ value: v.id, label: v.fleetNumber })),
                ]}
              />
            </Field>
            <Button icon={PlusIcon} onClick={addTrailer}>
              Add
            </Button>
          </div>

          <div className="fleet-field-group fleet-field-narrow">
            <Field label="Effective from">
              <TextInput
                id="rigEffectiveOn"
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
              />
            </Field>
            <p className="fleet-hint">Leave empty for today.</p>
          </div>

          <div>
            <Button
              variant="primary"
              type="submit"
              disabled={motiveId === "" || towed.length === 0 || create.isPending}
            >
              {create.isPending ? "Setting…" : "Set rig"}
            </Button>
          </div>
        </form>

        {create.isSuccess && create.result && (
          <p role="status">Rig set for {create.result.motiveFleetNumber}.</p>
        )}
        {create.error !== null && (
          <Banner tone="critical" title={refusalMessage(create.error, CREATE_WORDING)} />
        )}
      </div>
    </Card>
  );
}
