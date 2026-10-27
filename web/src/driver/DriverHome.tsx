import { Card } from "../ui/Card";
import { ListRow } from "../ui/ListRow";
import { useTenantDate } from "../time/tenantTime";
import { useMyTasks, useMyTrip, type MyTask } from "./driver.data";
import { homeView } from "./driver.view";
import "./driver.css";

// Composed to sit inside the shell's DriverShell (shell/), so it renders
// no second banner or main of its own.
export function DriverHome() {
  const tasks = useMyTasks();
  const trip = useMyTrip();
  const view = homeView(
    tasks.isSuccess ? tasks.data : undefined,
    trip.isSuccess ? trip.data : undefined,
  );

  return (
    <section className="tr-stack driver-home" aria-labelledby="my-inspections-heading">
      {/* The heading stays outside the loading and error branches: a view
          that loses its title while fetching leaves a screen reader with
          nothing to announce, and a test with nothing to find. */}
      <h1 id="my-inspections-heading" className="driver-home__title">
        My inspections
      </h1>
      {(tasks.isPending || (tasks.isError && trip.isPending)) && (
        <p className="driver-home__note">Loading…</p>
      )}
      {tasks.isError && (
        <p role="alert" className="driver-home__alert">
          Could not load your inspections.
        </p>
      )}
      {trip.isError && (
        <p role="alert" className="driver-home__alert">
          Could not load your trip.
        </p>
      )}

      {view.ungrouped && (
        <div className="driver-home__rows">
          <TaskLinks tasks={view.ungrouped} />
        </div>
      )}

      {view.trip && (
        <Card title="Your trip" padding="none">
          <ul className="tr-list driver-home__list">
            {view.trip.map((u) => {
              // A unit with nothing due is named, not linked (spec, The driver's phone);
              // a capture without a task is TYRE-319's question.
              if (u.due.length === 0) {
                return (
                  <li key={u.vehicleId}>
                    <ListRow>{u.fleetNumber}</ListRow>
                  </li>
                );
              }
              return u.due.map((t) => (
                <li key={t.id}>
                  <TaskLink task={t} />
                </li>
              ));
            })}
          </ul>
          {view.nothingDue && <p className="driver-home__empty">Nothing due.</p>}
        </Card>
      )}

      {view.nominated.length > 0 && (
        <Card title="Nominated inspections" padding="none">
          <TaskLinks tasks={view.nominated} />
        </Card>
      )}

      {view.notOnTrip && <p className="driver-home__note">You are not on a trip.</p>}
    </section>
  );
}

function TaskLinks({ tasks }: { tasks: readonly MyTask[] }) {
  return (
    <ul className="tr-list driver-home__list">
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
function TaskLink({ task }: { task: MyTask }) {
  const tenantDate = useTenantDate();
  return (
    <ListRow to={`/capture/${task.captureVehicleId ?? task.vehicleId}?taskId=${task.id}`}>
      {task.fleetNumber}, due {tenantDate(task.dueAt)}
      {/* Never colour alone (NFR-USE-009): overdue says so in words. */}
      {task.overdue ? " (overdue)" : ""}
    </ListRow>
  );
}
