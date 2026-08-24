import { useQuery } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { getDevTenantId } from "../api/devTenant";

interface Task {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
}

// FR-DSH-012: the driver's landing view is their own units and their own
// outstanding work — not the fleet, which they cannot read at all.
export function DriverHome() {
  const tenantKey = getDevTenantId() ?? "default";
  const tasks = useQuery({
    queryKey: ["my-tasks", tenantKey],
    queryFn: () => apiGet<Task[]>("/api/my/tasks"),
  });

  return (
    <section aria-labelledby="my-inspections-heading">
      {/* The heading stays outside the loading and error branches: a view
          that loses its title while fetching leaves a screen reader with
          nothing to announce, and a test with nothing to find. */}
      <h1 id="my-inspections-heading">My inspections</h1>
      {tasks.isPending && <p>Loading…</p>}
      {tasks.isError && <p role="alert">Could not load your inspections.</p>}
      {tasks.isSuccess &&
        (tasks.data.length === 0 ? (
          <p>Nothing due.</p>
        ) : (
          <ul>
            {tasks.data.map((t) => (
              <li key={t.id}>
                {t.fleetNumber} — due {new Date(t.dueAt).toLocaleDateString()}
                {/* Never colour alone (NFR-USE-009): overdue says so in words. */}
                {t.overdue ? " (overdue)" : ""}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
