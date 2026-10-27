import type { MyTask, MyTrip, TripUnit } from "./driver.data";

export interface TripRow extends TripUnit {
  due: MyTask[];
}

export interface HomeView {
  // The tasks before both reads have answered, or when the trip read fails,
  // so the one tap to a task never waits on the second read.
  ungrouped: readonly MyTask[] | null;
  // The truck first, then each trailer in the rig's order.
  trip: TripRow[] | null;
  nothingDue: boolean;
  nominated: MyTask[];
  notOnTrip: boolean;
}

// FR-DSH-012 as amended: the truck of the driver's open trip and the
// trailers it tows, with what is due on each, then any unit they are
// nominated for. Each argument is undefined until its read has succeeded.
export function homeView(tasks: readonly MyTask[] | undefined, trip: MyTrip | undefined): HomeView {
  const units = trip?.trip ? [trip.trip.motive, ...trip.trip.trailers] : null;
  const onTrip = new Set(units?.map((u) => u.vehicleId));
  const grouped = tasks !== undefined && trip !== undefined;
  return {
    ungrouped: tasks !== undefined && !grouped ? tasks : null,
    trip:
      units?.map((u) => ({ ...u, due: tasks?.filter((t) => t.vehicleId === u.vehicleId) ?? [] })) ??
      null,
    nothingDue:
      units !== null && tasks !== undefined && !tasks.some((t) => onTrip.has(t.vehicleId)),
    nominated: grouped ? tasks.filter((t) => !onTrip.has(t.vehicleId)) : [],
    notOnTrip: grouped && units === null && tasks.length === 0,
  };
}
