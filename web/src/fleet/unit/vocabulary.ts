// The unit screen's shared wording. Enum values are the database's and the
// labels are not: a screen says "mark outboard", app.mount_orientation says
// MARK_OUTBOARD, and neither should have to become the other. Kept out of
// the component files because react-refresh's only-export-components rule
// refuses a non-component export beside a component, and more than one
// component on this screen needs each list.

// CHG-010 (OI-28's answer): outer/centre/inner are relative to the vehicle
// centreline, so which sidewall carries the manufacturer's mark is a fact
// about the mounting, not about the tyre.
export const MOUNT_ORIENTATIONS: { value: string; label: string }[] = [
  { value: "MARK_OUTBOARD", label: "Mark outboard" },
  { value: "MARK_INBOARD", label: "Mark inboard" },
  { value: "UNKNOWN", label: "Unknown" },
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
// unrecognised source falls back to its own value rather than to silence —
// an unlabelled number would read as measured.
export function distanceSourceLabel(source: string): string {
  return DISTANCE_SOURCES[source] ?? source;
}

export function orientationLabel(value: string): string {
  return MOUNT_ORIENTATIONS.find((o) => o.value === value)?.label ?? value;
}
