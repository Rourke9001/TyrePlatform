import { taskPath } from "../capture/taskGate";
import { useTenantDate } from "../time/tenantTime";
import { ListRow } from "../ui/ListRow";
import type { MyTask } from "./driver.data";
import "./driver.css";

// The one task row, shared by "My inspections" and the capture pick screen so
// the two lists cannot drift (TYRE-491).
export function TaskLinks({ tasks }: { tasks: readonly MyTask[] }) {
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
export function TaskLink({ task }: { task: MyTask }) {
  const tenantDate = useTenantDate();
  return (
    <ListRow to={taskPath(task)}>
      {task.fleetNumber}, due {tenantDate(task.dueAt)}
      {/* Never colour alone (NFR-USE-009): overdue says so in words. */}
      {task.overdue ? " (overdue)" : ""}
    </ListRow>
  );
}
