import { apiGet, apiPost } from "./client";

// Wire shapes of the trip surface (api/internal/httpapi/trips.go, TYRE-326).
// Every rule is the server's: what may go on a trip, which trailers may be
// added and what holds a start are app.start_trip's and
// app.trip_start_blockers' (000060). DriverHome reads /api/my/trip itself, so
// this module stays out of the capture bundle.

export interface TripUnit {
  vehicleId: string;
  fleetNumber: string;
}

export interface TripPerson {
  userId: string;
  displayName: string;
}

// trailers is the motive's open rig as it stands, after the motive.
export interface Trip {
  id: string;
  motive: TripUnit;
  driver: TripPerson;
  startedAt: string;
  startedBy: TripPerson | null;
  endedAt: string | null;
  trailers: TripUnit[];
}

// A motive's open trip; a towed trailer's motive and that motive's trip;
// neither for a free trailer or a motive between trips.
export interface UnitTrip {
  trip: Trip | null;
  pulledBy: TripUnit | null;
}

// onTrip names the truck a start for this driver would take them off.
export interface Driver {
  userId: string;
  displayName: string;
  staffNumber: string | null;
  onTrip: TripUnit | null;
}

export interface NewTrip {
  motiveVehicleId: string;
  driverUserId: string;
  addTrailers: string[];
}

// One open task that holds a start (U148); dueAt renders as a tenant day.
export interface TripBlocker {
  taskId: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
}

export function fetchUnitTrip(unitId: string): Promise<UnitTrip> {
  return apiGet<UnitTrip>(`/api/vehicles/${unitId}/trip`);
}

export function fetchDrivers(): Promise<Driver[]> {
  return apiGet<Driver[]>("/api/drivers");
}

export function fetchTripBlockers(unitId: string, addTrailers: string[]): Promise<TripBlocker[]> {
  const query =
    addTrailers.length > 0 ? `?addTrailers=${addTrailers.map(encodeURIComponent).join(",")}` : "";
  return apiGet<TripBlocker[]>(`/api/vehicles/${unitId}/trip-blockers${query}`);
}

export function startTrip(body: NewTrip): Promise<Trip> {
  return apiPost<Trip>("/api/trips", body);
}

export function endTrip(tripId: string): Promise<Trip> {
  return apiPost<Trip>(`/api/trips/${tripId}/end`, {});
}
