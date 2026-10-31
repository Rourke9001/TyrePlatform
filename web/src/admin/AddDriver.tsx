import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createUser, type CreatedUser, type TenantRole } from "../api/admin";
import { ApiError } from "../api/client";
import { refusalMessage } from "../api/refusal";
import { useCan } from "../auth/actorContext";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { TextInput } from "../ui/TextInput";
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
    <section aria-labelledby="add-user-heading" className="adm-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader title={<span id="add-user-heading">Add a user</span>} />

      <Card>
        <form className="tr-stack" onSubmit={submitUser}>
          <Field label="Email address">
            <TextInput
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>

          <Field label="Name">
            <TextInput
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </Field>

          {/* FR-AUT-022: a durable identifier independent of the display name,
              and optional. R13 identifies its driver as "Melusi" and nothing
              else. */}
          <Field label="Staff number">
            <TextInput
              id="staffNumber"
              mono
              value={staffNumber}
              onChange={(e) => setStaffNumber(e.target.value)}
            />
          </Field>

          <Field label="Role">
            <Select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value as TenantRole)}
              required
              options={roles}
            />
          </Field>

          <div>
            <Button variant="primary" type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add user"}
            </Button>
          </div>
        </form>
      </Card>

      {create.isError && rehire === null && (
        <Banner tone="critical" title={refused(create.error)} />
      )}
      {rehire !== null && (
        <>
          <Banner tone="critical" title={rehire.message} />
          {/* A focusable descendant of role="alert" is not reliably surfaced
              by assistive tech, which announces the region's text and stops;
              the button is a sibling so a screen-reader user can reach it. */}
          <div>
            <Button
              className="adm-reactivate"
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
            </Button>
          </div>
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
