import { useEffect, useRef, useState } from "react";

import { stampSubject } from "../api/token";
import { draftPath } from "../capture/draft";
import { mayCarry, readHeldDraft, type HeldDraft } from "../capture/outbox";
import { Card } from "../ui/Card";
import { ListRow } from "../ui/ListRow";
import { useTenantInstant } from "../time/tenantTime";
import { useMyTasks, useMyTrip } from "./driver.data";
import { homeView } from "./driver.view";
import { InstallHint } from "./InstallHint";
import { TaskLink, TaskLinks } from "./TaskLink";
import "./driver.css";

// The draft held on this phone, read once per visit as InstallHint reads
// held work. A failed read is no draft: the task rows still resume a draft
// for their own unit (TYRE-319 spec, section 5).
function useHeldDraft(): HeldDraft | null | "reading" {
  const [held, setHeld] = useState<HeldDraft | null | "reading">("reading");
  useEffect(() => {
    let live = true;
    readHeldDraft().then(
      (draft) => {
        if (live) setHeld(draft);
      },
      () => {
        if (live) setHeld(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return held;
}

// Renders inside Chrome's frame (shell/Chrome.tsx), AppShell or DriverShell,
// which owns the banner and main, so it has neither of its own.
export function DriverHome() {
  const tasks = useMyTasks();
  const trip = useMyTrip();
  const held = useHeldDraft();
  const heading = useRef<HTMLHeadingElement>(null);
  const view = homeView(tasks.data, trip.data);
  // A failure is read only with no data, as CaptureFlow reads one: a list in
  // hand outlives a failed refresh, with a notice (TYRE-334).
  const tasksFailed = tasks.isError && tasks.data === undefined;
  const tripFailed = trip.isError && trip.data === undefined;
  // The task rows wait on the local draft read, so the carry-on row never
  // moves a task once the list has painted (Lead's call 14).
  const reading = held === "reading";
  // Another driver's draft gets no row: capture says who must finish it.
  const carry = !reading && held !== null && mayCarry(held, stampSubject()) ? held : null;

  return (
    <section className="tr-stack driver-home" aria-labelledby="my-inspections-heading">
      {/* The heading stays outside the loading and error branches: a view
          that loses its title while fetching leaves a screen reader with
          nothing to announce, and a test with nothing to find. */}
      <h1 id="my-inspections-heading" ref={heading} tabIndex={-1} className="driver-home__title">
        My inspections
      </h1>
      {(tasks.isPending || (tasksFailed && trip.isPending) || reading) && (
        <p className="driver-home__note">Loading…</p>
      )}
      {tasksFailed && (
        <p role="alert" className="driver-home__alert">
          Could not load your inspections.
        </p>
      )}
      {tripFailed && (
        <p role="alert" className="driver-home__alert">
          Could not load your trip.
        </p>
      )}
      {tasks.isError && tasks.data !== undefined && (
        <p role="status" className="driver-home__notice">
          Could not refresh your inspections. This list may be out of date.
        </p>
      )}
      {trip.isError && trip.data !== undefined && (
        <p role="status" className="driver-home__notice">
          Could not refresh your trip. It may be out of date.
        </p>
      )}

      {carry && (
        <div className="driver-home__rows">
          <ul className="tr-list driver-home__list">
            <li>
              <CarryOnRow draft={carry} />
            </li>
          </ul>
        </div>
      )}

      {!reading && view.ungrouped && (
        <div className="driver-home__rows">
          <TaskLinks tasks={view.ungrouped} />
        </div>
      )}

      {!reading && view.trip && (
        <Card title="Your trip" padding="none">
          <ul className="tr-list driver-home__list">
            {view.trip.map((u) => {
              // A unit with nothing due is named, not linked, since a scoped
              // capture starts only from a task (TYRE-319, U143).
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

      {!reading && view.nominated.length > 0 && (
        <Card title="Nominated inspections" padding="none">
          <TaskLinks tasks={view.nominated} />
        </Card>
      )}

      {!reading && view.notOnTrip && <p className="driver-home__note">You are not on a trip.</p>}

      {/* The last block, and only once the lists are in, so it never moves a
          task or slides under a thumb (TYRE-154, U243). */}
      {!tasks.isPending && !trip.isPending && !reading && <InstallHint focusAfter={heading} />}
    </section>
  );
}

// TYRE-319 (the owner's answer 1): the way back to a held inspection, whether
// or not its task is still listed. A task row's size, above every task.
function CarryOnRow({ draft }: { draft: HeldDraft }) {
  const tenantInstant = useTenantInstant();
  return (
    <ListRow to={draftPath(draft)}>
      Carry on with {draft.fleetNumber ?? "your inspection"}, started{" "}
      {tenantInstant(draft.startedAt)}
    </ListRow>
  );
}
