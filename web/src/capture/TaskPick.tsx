import type { MyTask } from "../driver/driver.data";
import { TaskLinks } from "../driver/TaskLink";
import { BackToWork } from "./CaptureDone";
import "./capture.css";

// TYRE-491, the owner's answer 1 (U246): with several tasks due on the unit
// the driver picks. A row is the "My inspections" row, so the two lists
// cannot drift, and the tap only navigates: this screen holds no state.
export function TaskPick({ tasks }: { tasks: readonly MyTask[] }) {
  return (
    <section className="cap-screen">
      <p className="cap-screen-sub">
        More than one inspection is due on this vehicle. Choose the one to start.
      </p>
      <div className="driver-home__rows">
        <TaskLinks tasks={tasks} />
      </div>
      <BackToWork />
    </section>
  );
}
