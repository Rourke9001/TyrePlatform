import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createUser, type CreatedUser, type TenantRole } from "../api/admin";
import { ApiError } from "../api/client";
import { refusalMessage } from "../api/refusal";
import { useCan } from "../auth/actorContext";
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

function refused(error: unknown): string {
  return refusalMessage(error, {
    speakable: ["email_taken", "email_inactive", "nothing_to_reactivate", "staff_number_taken"],
    forbidden: "You do not have permission to add a user.",
    fallback: "Could not add a user. Try again, or call support if it keeps happening.",
  });
}

// FR-AUT-010's invite (D9, ADR-0011: ManageUsers or InviteDriver). A driver
// reaches capture through a trip or a nomination, which the unit screen
// makes (FR-AUT-005 as amended), so creating one ends here.
export function AddDriver() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [staffNumber, setStaffNumber] = useState("");
  const [role, setRole] = useState<TenantRole>("DRIVER");
  const [created, setCreated] = useState<CreatedUser | null>(null);
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

  const create = useMutation({
    mutationFn: createUser,
    onSuccess: (user, variables) => {
      setCreated(user);
      setRestored(variables.reactivate === true);
      setEmail("");
      setDisplayName("");
      setStaffNumber("");
      setRehire(null);
    },
    onError: (error) => {
      setRehire(
        error instanceof ApiError && error.code === "email_inactive"
          ? { email, message: refused(error) }
          : null,
      );
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

      {create.isError && rehire === null && <p role="alert">{refused(create.error)}</p>}
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
    </section>
  );
}
