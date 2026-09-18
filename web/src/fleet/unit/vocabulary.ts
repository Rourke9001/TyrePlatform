// The unit screen's shared wording: enum values are the database's,
// labels are not. Its own module for the reason queryKeys.ts is one
// (react-refresh).

// app.mount_orientation's third member, named because D13 says the fit
// form's default is the unasserted one; declared once so a screen cannot
// come to hold a value the radios do not offer (TYRE-128).
export const ORIENTATION_UNKNOWN = "UNKNOWN";

// CHG-010 (OI-28's answer): outer/centre/inner are relative to the vehicle
// centreline, so which sidewall carries the manufacturer's mark is a fact
// about the mounting, not about the tyre.
export const MOUNT_ORIENTATIONS: { value: string; label: string }[] = [
  { value: "MARK_OUTBOARD", label: "Mark outboard" },
  { value: "MARK_INBOARD", label: "Mark inboard" },
  { value: ORIENTATION_UNKNOWN, label: "Unknown" },
];

// app.vehicle_status' six members (FR-VEH-005). Which transitions between
// them are legal is app.set_vehicle_status' rule, never this list's.
export const UNIT_STATUSES: { value: string; label: string }[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "WORKSHOP", label: "Workshop" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "DISPOSED", label: "Disposed" },
  { value: "PARKED", label: "Parked" },
  { value: "OUT_OF_SERVICE", label: "Out of service" },
];

const DISTANCE_SOURCES: Record<string, string> = {
  MEASURED: "Measured",
  INFERRED: "Inferred",
  UNAVAILABLE: "Unavailable",
};

// CR-012: a distance is never shown without where it came from. An
// unrecognised source falls back to its own value rather than to silence.
// An unlabelled number would read as measured.
export function distanceSourceLabel(source: string): string {
  return DISTANCE_SOURCES[source] ?? source;
}

export function orientationLabel(value: string): string {
  return MOUNT_ORIENTATIONS.find((o) => o.value === value)?.label ?? value;
}
