import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { assignDriver, createUser, type CreatedUser, type TenantRole } from "../api/admin";
import { ApiError } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import { refusalMessage } from "../api/refusal";
import { fetchVehicles } from "../api/vehicles";
import { useCan } from "../auth/actorContext";
import { vehiclesKey } from "../fleet/unit/queryKeys";
import "./admin.css";

// The roles a tenant may create. PLATFORM_ADMIN is absent because it is not
// creatable through a tenant surface at all (ADR-0011, ADR-0013). This is the
// full list; the component narrows it per actor before rendering (D9).
const ROLES: { value: TenantRole; label: string }[] = [
  { value: "DRIVER", label: "Driver" },
  { value: "TECHNICIAN", label: "Technician" },
  { value: "CONTROLLER", label: "Controller" },
  { value: "DEPOT_MANAGER", label: "Depot manager" },
  { value: "ORG_ADMIN", label: "Organisation admin" },
];

// Shared by both mutations so the message names the action refused:
// ManageUsers and ManageAssignments are separate capabilities (TYRE-83); a
// wrong-action sentence points at the wrong one.
function refused(error: unknown, action: "add a user" | "assign a unit"): string {
  return refusalMessage(error, {
    speakable: [
      "email_taken",
      "email_inactive",
      "nothing_to_reactivate",
      "assignment_overlaps",
      "staff_number_taken",
    ],
    forbidden: `You do not have permission to ${action}.`,
    fallback: `Could not ${action}. Try again, or call support if it keeps happening.`,
  });
}

// FR-AUT-010's invite (D9, ADR-0011: ManageUsers or InviteDriver). Assignment
// follows create, not its own screen: an unassigned driver reaches no
// capture (FR-AUT-005, app.v_capture_vehicle).
export function AddDriver() {
  const tenantKey = getDevTenantId() ?? "default";
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [staffNumber, setStaffNumber] = useState("");
  const [role, setRole] = useState<TenantRole>("DRIVER");
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  // Tanstack Query v5 clears create.error once Reactivate's mutation starts;
  // re-deriving from it here would announce the fallback over a retry that
  // is succeeding. Captured once in onError, kept regardless (D10).
  const [rehire, setRehire] = useState<{ email: string; message: string } | null>(null);
  // "restored" vs "added" (TYRE-95): derived from which request succeeded,
  // so it cannot claim a stranger joined when history came back.
  const [restored, setRestored] = useState(false);

  // D9. ManageUsers offers the whole list; InviteDriver alone offers DRIVER.
  // The server decides the same question again (mayCreateRole). This only
  // keeps the form from expressing a request it knows will be refused.
  const canManageUsers = useCan("ManageUsers");
  const roles = canManageUsers ? ROLES : ROLES.filter((r) => r.value === "DRIVER");

  const vehicles = useQuery({
    queryKey: vehiclesKey(tenantKey),
    queryFn: fetchVehicles,
    // The list is only needed once there is somebody to assign.
    enabled: created !== null,
  });

  const create = useMutation({
    mutationFn: createUser,
    onSuccess: (user, variables) => {
      setCreated(user);
      setRestored(variables.reactivate === true);
      setAssignedTo(null);
      setEmail("");
      setDisplayName("");
      setStaffNumber("");
      setRehire(null);
    },
    onError: (error) => {
      setRehire(
        error instanceof ApiError && error.code === "email_inactive"
          ? { email, message: refused(error, "add a user") }
          : null,
      );
    },
  });

  const assign = useMutation({
    mutationFn: (id: string) => assignDriver(id, { userId: created?.id ?? "" }),
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
            and optional. R13 identifies its driver as "Melusi" and nothing
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
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add user"}
        </button>
      </form>

      {create.isError && rehire === null && (
        <p role="alert">{refused(create.error, "add a user")}</p>
      )}
      {rehire !== null && (
        <>
          <p role="alert">{rehire.message}</p>
          {/* A focusable descendant of role="alert" is not reliably surfaced
              by assistive tech, which announces the region's text and stops;
              the button is a sibling so a screen-reader user can reach it. */}
          <button
            type="button"
            disabled={create.isPending}
            onClick={() =>
              create.mutate({
                email: rehire.email,
                displayName,
                staffNumber: staffNumber === "" ? undefined : staffNumber,
                role,
                reactivate: true,
              })
            }
          >
            Reactivate {rehire.email}
          </button>
        </>
      )}
      {created && (
        <p role="status">
          {created.displayName} was {restored ? "restored" : "added"}.
        </p>
      )}

      {created && (
        <form onSubmit={submitAssignment}>
          <h2>Assign to a unit</h2>
          {vehicles.isPending && <p>Loading units…</p>}
          {vehicles.isError && <p role="alert">The unit list could not be loaded.</p>}
          {/* A silent no-op here, an Assign button over an empty select, is
              worse than telling the admin there is nothing to assign to yet
              (NFR-USE-005). */}
          {vehicles.isSuccess && vehicles.data.length === 0 && (
            <p>No units yet. Add a unit first.</p>
          )}
          {vehicles.isSuccess && vehicles.data.length > 0 && (
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

      {assign.isError && <p role="alert">{refused(assign.error, "assign a unit")}</p>}
      {assignedTo && <p role="status">Assigned to {assignedTo}.</p>}
    </section>
  );
}
