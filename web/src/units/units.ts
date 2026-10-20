import { useMemo } from "react";

import { useActor } from "../auth/actorContext";

// FR-CFG-021: the words a pressure and a distance render under, from the
// tenant's codes on GET /api/me. Pressure is stored in kPa and distance in
// km, and the database admits no other unit until conversion is built
// (tenant_metric_units, 000059), so an absent code reads as metric. A code
// this module does not know is shown as itself, never relabelled.
export interface UnitLabels {
  pressure: string;
  distance: string;
  // The distance's name in a sentence, "whole kilometres".
  distanceWord: string;
}

const PRESSURE: Readonly<Partial<Record<string, string>>> = { KPA: "kPa" };
const DISTANCE: Readonly<Partial<Record<string, { short: string; word: string }>>> = {
  KM: { short: "km", word: "kilometres" },
};

export function unitLabels(
  pressureUnit: string | undefined,
  distanceUnit: string | undefined,
): UnitLabels {
  const pressure = pressureUnit ?? "KPA";
  const distance = distanceUnit ?? "KM";
  const known = DISTANCE[distance];
  return {
    pressure: PRESSURE[pressure] ?? pressure,
    distance: known?.short ?? distance,
    distanceWord: known?.word ?? distance,
  };
}

// Memoised on the two codes, so a component passing the labels on does not
// hand its children a new object every render.
export function useUnitLabels(): UnitLabels {
  const actor = useActor();
  const pressure = actor?.pressureUnit;
  const distance = actor?.distanceUnit;
  return useMemo(() => unitLabels(pressure, distance), [pressure, distance]);
}
