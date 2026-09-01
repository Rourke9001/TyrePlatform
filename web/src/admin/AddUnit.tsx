import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createUnit, fetchAxleConfigurations, type CreatedUnit, type UnitKind } from "../api/admin";
import { refusalMessage } from "../api/refusal";
import { getDevTenantId } from "../api/devTenant";
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
// is not here and is ORG_ADMIN's alone through ManageTemplates (TYRE-84) — this
// screen picks from the library and never adds to it.
export function AddUnit() {
  const tenantKey = getDevTenantId() ?? "default";
  const configs = useQuery({
    queryKey: ["axle-configurations", tenantKey],
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
    <section aria-labelledby="add-unit-heading" className="adm-form">
      <h1 id="add-unit-heading">Add a unit</h1>

      {configs.isPending && <p>Loading…</p>}
      {configs.isError && (
        <p role="alert">
          The axle configuration library could not be loaded, so a unit cannot be added yet.
        </p>
      )}

      {configs.isSuccess && (
        <form onSubmit={submit}>
          <label htmlFor="fleetNumber">Fleet number</label>
          {/* FR-VEH-003: alphanumeric, never assumed numeric — so this is a
              text input with no pattern, and the server checks only that
              there is one. */}
          <input
            id="fleetNumber"
            value={fleetNumber}
            onChange={(e) => setFleetNumber(e.target.value)}
            required
          />

          <label htmlFor="registration">Registration</label>
          <input
            id="registration"
            value={registration}
            onChange={(e) => setRegistration(e.target.value)}
          />

          <label htmlFor="unitKind">Unit kind</label>
          <select
            id="unitKind"
            value={unitKind}
            onChange={(e) => setUnitKind(e.target.value as UnitKind)}
            required
          >
            <option value="">Choose…</option>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>

          <label htmlFor="configurationId">Axle configuration</label>
          <select
            id="configurationId"
            value={configurationId === "" ? (configs.data[0]?.id ?? "") : configurationId}
            onChange={(e) => setConfigurationId(e.target.value)}
            required
          >
            {configs.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code} v{c.version})
              </option>
            ))}
          </select>

          <button type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add unit"}
          </button>
        </form>
      )}

      {create.isError && <p role="alert">{refusalMessage(create.error, CREATE_WORDING)}</p>}
      {added && <p role="status">{added.fleetNumber} was added.</p>}
    </section>
  );
}
