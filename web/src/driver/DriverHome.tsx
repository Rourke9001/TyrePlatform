import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { apiGet } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import { useTenantDate } from "../time/tenantTime";

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
  const tenantDate = useTenantDate();
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
                {/* The whole task is the target: this is the one tap between a
                    driver opening the app and entering their first reading,
                    and it carries the task so submitting can close it. */}
                <Link to={`/capture/${t.vehicleId}?taskId=${t.id}`}>
                  {t.fleetNumber} — due {tenantDate(t.dueAt)}
                  {/* Never colour alone (NFR-USE-009): overdue says so in words. */}
                  {t.overdue ? " (overdue)" : ""}
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
