import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createUnit, fetchAxleConfigurations, type CreatedUnit, type UnitKind } from "../api/admin";
import { refusalMessage } from "../api/refusal";
import { getDevTenantId } from "../api/devTenant";
import { axleConfigurationsKey } from "../fleet/unit/queryKeys";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { TextInput } from "../ui/TextInput";
import "./admin.css";

// The kinds a unit can be, in the order a fleet thinks of them. The values are
// app.unit_kind's and the labels are not: a screen says "horse", the enum says
// HORSE, and neither should have to become the other.
const KINDS: { value: UnitKind; label: string }[] = [
  { value: "HORSE", label: "Horse" },
  { value: "TRAILER", label: "Trailer" },
  { value: "RIGID", label: "Rigid" },
  { value: "LIGHT", label: "Light vehicle" },
];

const CREATE_WORDING = {
  speakable: ["fleet_number_taken"],
  forbidden: "You do not have permission to add a unit.",
  fallback: "The unit could not be added. Try again, or call support if it keeps happening.",
};

// FR-VEH-001..005, gated on ManageAssets (D8). Authoring an axle configuration
// is not here and is ORG_ADMIN's alone through ManageTemplates (TYRE-84). This
// screen picks from the library and never adds to it.
export function AddUnit() {
  const tenantKey = getDevTenantId() ?? "default";
  const configs = useQuery({
    queryKey: axleConfigurationsKey(tenantKey),
    queryFn: fetchAxleConfigurations,
  });

  const [fleetNumber, setFleetNumber] = useState("");
  const [registration, setRegistration] = useState("");
  const [unitKind, setUnitKind] = useState<UnitKind | "">("");
  const [configurationId, setConfigurationId] = useState("");
  const [added, setAdded] = useState<CreatedUnit | null>(null);

  const create = useMutation({
    mutationFn: createUnit,
    onSuccess: (unit) => {
      setAdded(unit);
      setFleetNumber("");
      setRegistration("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (unitKind === "") return;
    setAdded(null);
    create.mutate({
      fleetNumber,
      registration: registration === "" ? undefined : registration,
      configurationId: configurationId === "" ? (configs.data?.[0]?.id ?? "") : configurationId,
      unitKind,
    });
  }

  return (
    <section aria-labelledby="add-unit-heading" className="adm-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader title={<span id="add-unit-heading">Add a unit</span>} />

      {configs.isPending && <p>Loading…</p>}
      {configs.isError && (
        <Banner
          tone="critical"
          title="The axle configuration library could not be loaded, so a unit cannot be added yet."
        />
      )}

      {configs.isSuccess && (
        <Card>
          <form className="tr-stack" onSubmit={submit}>
            {/* FR-VEH-003: alphanumeric, never assumed numeric, so this is a
                text input with no pattern, and the server checks only that
                there is one. */}
            <Field label="Fleet number">
              <TextInput
                id="fleetNumber"
                mono
                value={fleetNumber}
                onChange={(e) => setFleetNumber(e.target.value)}
                required
              />
            </Field>

            <Field label="Registration">
              <TextInput
                id="registration"
                mono
                value={registration}
                onChange={(e) => setRegistration(e.target.value)}
              />
            </Field>

            <Field label="Unit kind">
              <Select
                id="unitKind"
                value={unitKind}
                onChange={(e) => setUnitKind(e.target.value as UnitKind)}
                required
                options={[{ value: "", label: "Choose…" }, ...KINDS]}
              />
            </Field>

            <Field label="Axle configuration">
              <Select
                id="configurationId"
                value={configurationId === "" ? (configs.data[0]?.id ?? "") : configurationId}
                onChange={(e) => setConfigurationId(e.target.value)}
                required
                options={configs.data.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.code} v${String(c.version)})`,
                }))}
              />
            </Field>

            <div>
              <Button variant="primary" type="submit" disabled={create.isPending}>
                {create.isPending ? "Adding…" : "Add unit"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {create.isError && (
        <Banner tone="critical" title={refusalMessage(create.error, CREATE_WORDING)} />
      )}
      {added && <p role="status">{added.fleetNumber} was added.</p>}
    </section>
  );
}
