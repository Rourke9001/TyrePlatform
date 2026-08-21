import type { Vehicle } from "../api/vehicles";

// numeric: true is what makes BAC2 sort before BAC10 (NFR-USE-012 — natural
// order, not lexicographic).
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// Drivers know vehicles by registration as much as by fleet number
// (FR-VEH-022), so one search box matches both.
export function searchVehicles(vehicles: Vehicle[], query: string): Vehicle[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? vehicles.filter(
        (v) =>
          v.fleetNumber.toLowerCase().includes(q) ||
          (v.registration ?? "").toLowerCase().includes(q),
      )
    : [...vehicles];
  return matches.sort((a, b) => collator.compare(a.fleetNumber, b.fleetNumber));
}
