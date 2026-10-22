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
  // The unit the task is captured through: a coupled trailer's motive, so
  // the rig is captured whole. Optional: an API older than the web sends
  // none, and the task's own unit stands in.
  captureVehicleId?: string;
}

// The fields of GET /api/my/trip this screen renders, declared here rather
// than imported: api/trips.ts is the fleet screens' and stays out of the
// capture entry (web/CLAUDE.md, The design system).
interface TripUnit {
  vehicleId: string;
  fleetNumber: string;
}

interface MyTrip {
  trip: { motive: TripUnit; trailers: TripUnit[] } | null;
}

// FR-DSH-012 as amended: the driver's landing view is the truck of their
// open trip and the trailers it tows, with what is due on each, then any
// unit they are nominated for. Never the fleet, which they cannot read.
export function DriverHome() {
  const tenantKey = getDevTenantId() ?? "default";
  const tasks = useQuery({
    queryKey: ["my-tasks", tenantKey],
    queryFn: () => apiGet<Task[]>("/api/my/tasks"),
  });
  const trip = useQuery({
    queryKey: ["my-trip", tenantKey],
    queryFn: () => apiGet<MyTrip>("/api/my/trip"),
  });

  const tripUnits = trip.isSuccess && trip.data.trip !== null ? unitsOf(trip.data.trip) : null;
  const onTrip = new Set(tripUnits?.map((u) => u.vehicleId));
  // Grouped only once both reads have answered; until then, or when the
  // trip read fails, the links stand ungrouped so the one tap to a task
  // never waits on the second read.
  const grouped = tasks.isSuccess && trip.isSuccess;
  const nominated = grouped ? tasks.data.filter((t) => !onTrip.has(t.vehicleId)) : [];

  return (
    <section aria-labelledby="my-inspections-heading">
      {/* The heading stays outside the loading and error branches: a view
          that loses its title while fetching leaves a screen reader with
          nothing to announce, and a test with nothing to find. */}
      <h1 id="my-inspections-heading">My inspections</h1>
      {(tasks.isPending || (tasks.isError && trip.isPending)) && <p>Loading…</p>}
      {tasks.isError && <p role="alert">Could not load your inspections.</p>}
      {trip.isError && <p role="alert">Could not load your trip.</p>}

      {tasks.isSuccess && !grouped && <TaskLinks tasks={tasks.data} />}

      {tripUnits !== null && (
        <section aria-labelledby="my-trip-heading">
          <h2 id="my-trip-heading">Your trip</h2>
          <ul>
            {tripUnits.map((u) => {
              const due = tasks.isSuccess
                ? tasks.data.filter((t) => t.vehicleId === u.vehicleId)
                : [];
              // A unit with nothing due is named, not linked (spec, The driver's phone);
              // a capture without a task is TYRE-319's question.
              if (due.length === 0) return <li key={u.vehicleId}>{u.fleetNumber}</li>;
              return due.map((t) => (
                <li key={t.id}>
                  <TaskLink task={t} />
                </li>
              ));
            })}
          </ul>
          {tasks.isSuccess && !tasks.data.some((t) => onTrip.has(t.vehicleId)) && (
            <p>Nothing due.</p>
          )}
        </section>
      )}

      {nominated.length > 0 && (
        <section aria-labelledby="my-nominated-heading">
          <h2 id="my-nominated-heading">Nominated inspections</h2>
          <TaskLinks tasks={nominated} />
        </section>
      )}

      {grouped && tripUnits === null && tasks.data.length === 0 && <p>You are not on a trip.</p>}
    </section>
  );
}

// The truck first, then each trailer in the rig's order.
function unitsOf(trip: NonNullable<MyTrip["trip"]>): TripUnit[] {
  return [trip.motive, ...trip.trailers];
}

function TaskLinks({ tasks }: { tasks: Task[] }) {
  return (
    <ul>
      {tasks.map((t) => (
        <li key={t.id}>
          <TaskLink task={t} />
        </li>
      ))}
    </ul>
  );
}

// The whole task is the target: this is the one tap between a driver opening
// the app and entering their first reading, and it carries the task so
// submitting can close it.
function TaskLink({ task }: { task: Task }) {
  const tenantDate = useTenantDate();
  return (
    <Link to={`/capture/${task.captureVehicleId ?? task.vehicleId}?taskId=${task.id}`}>
      {task.fleetNumber}, due {tenantDate(task.dueAt)}
      {/* Never colour alone (NFR-USE-009): overdue says so in words. */}
      {task.overdue ? " (overdue)" : ""}
    </Link>
  );
}
