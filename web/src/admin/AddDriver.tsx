import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { assignDriver, createUser, type CreatedUser, type TenantRole } from "../api/admin";
import { ApiError } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import { fetchVehicles } from "../api/vehicles";
import "./admin.css";

// The roles a tenant may create. PLATFORM_ADMIN is absent because it is not
// creatable through a tenant surface at all (ADR-0011, ADR-0013).
//
// D9 narrows this per actor — CONTROLLER and DEPOT_MANAGER will be able to
// create DRIVER alone — and TYRE-83 owns that. Until it lands the whole list
// is offered to whoever holds ManageUsers, which is ORG_ADMIN alone.
const ROLES: { value: TenantRole; label: string }[] = [
  { value: "DRIVER", label: "Driver" },
  { value: "TECHNICIAN", label: "Technician" },
  { value: "CONTROLLER", label: "Controller" },
  { value: "DEPOT_MANAGER", label: "Depot manager" },
  { value: "ORG_ADMIN", label: "Organisation admin" },
];

function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const speakable = ["invalid_submission", "email_taken", "assignment_overlaps", "conflict"];
    if (speakable.includes(error.code) && error.message !== "") {
      return error.message;
    }
    if (error.code === "forbidden") {
      return "You do not have permission to add a user.";
    }
  }
  return "The user could not be added. Try again, or call support if it keeps happening.";
}

// An assignment's from_date is a date, not a timestamp, so this is the
// browser's local calendar day — which is the person's own day, and is not
// the same thing as the tenant's configured timezone. They differ only for an
// admin working from another country, and a from_date one day out is
// correctable; taking a UTC instant instead would be wrong every evening in
// South Africa.
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// FR-AUT-010's invite, gated on ManageUsers. The assignment step follows the
// create rather than living on its own screen: a driver with no assignment
// reaches no capture (FR-AUT-005, app.v_capture_vehicle), so the two steps are
// one piece of work even though they are two writes.
export function AddDriver() {
  const tenantKey = getDevTenantId() ?? "default";
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [staffNumber, setStaffNumber] = useState("");
  const [role, setRole] = useState<TenantRole>("DRIVER");
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [assignedTo, setAssignedTo] = useState<string | null>(null);

  const vehicles = useQuery({
    queryKey: ["vehicles", tenantKey],
    queryFn: fetchVehicles,
    // The list is only needed once there is somebody to assign.
    enabled: created !== null,
  });

  const create = useMutation({
    mutationFn: createUser,
    onSuccess: (user) => {
      setCreated(user);
      setAssignedTo(null);
    },
  });

  const assign = useMutation({
    mutationFn: (id: string) => assignDriver(id, { userId: created?.id ?? "", fromDate: today() }),
    onSuccess: (_, id) => {
      setAssignedTo(vehicles.data?.find((v) => v.id === id)?.fleetNumber ?? null);
    },
  });

  function submitUser(e: FormEvent) {
    e.preventDefault();
    create.mutate({
      email,
      displayName,
      staffNumber: staffNumber === "" ? undefined : staffNumber,
      role,
    });
  }

  function submitAssignment(e: FormEvent) {
    e.preventDefault();
    const id = vehicleId === "" ? (vehicles.data?.[0]?.id ?? "") : vehicleId;
    if (id === "") return;
    assign.mutate(id);
  }

  return (
    <section aria-labelledby="add-user-heading" className="adm-form">
      <h1 id="add-user-heading">Add a user</h1>

      <form onSubmit={submitUser}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label htmlFor="displayName">Name</label>
        <input
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />

        {/* FR-AUT-022: a durable identifier independent of the display name,
            and optional — R13 identifies its driver as "Melusi" and nothing
            else. */}
        <label htmlFor="staffNumber">Staff number</label>
        <input
          id="staffNumber"
          value={staffNumber}
          onChange={(e) => setStaffNumber(e.target.value)}
        />

        <label htmlFor="role">Role</label>
        <select
          id="role"
          value={role}
          onChange={(e) => setRole(e.target.value as TenantRole)}
          required
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add user"}
        </button>
      </form>

      {create.isError && <p role="alert">{refusalMessage(create.error)}</p>}
      {created && <p role="status">{created.displayName} was added.</p>}

      {created && (
        <form onSubmit={submitAssignment}>
          <h2>Assign to a unit</h2>
          {vehicles.isPending && <p>Loading units…</p>}
          {vehicles.isError && <p role="alert">The unit list could not be loaded.</p>}
          {vehicles.isSuccess && (
            <>
              <label htmlFor="vehicleId">Unit</label>
              <select
                id="vehicleId"
                value={vehicleId === "" ? (vehicles.data[0]?.id ?? "") : vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
              >
                {vehicles.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.fleetNumber}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={assign.isPending}>
                {assign.isPending ? "Assigning…" : "Assign"}
              </button>
            </>
          )}
        </form>
      )}

      {assign.isError && <p role="alert">{refusalMessage(assign.error)}</p>}
      {assignedTo && <p role="status">Assigned to {assignedTo}.</p>}
    </section>
  );
}
