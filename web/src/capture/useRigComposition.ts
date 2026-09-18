import { useQueries } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import type { CaptureContext } from "./captureContext";
import { captureContextQuery } from "./captureContext";

// Owns the rig's composition (FR-INS-062/063): which member units are
// confirmed attached, the GETs over them, and the toggle. attachedIds is
// state the caller owns (CaptureFlow), since the draft's load effect and
// discard also write it.
export function useRigComposition(
  motive: CaptureContext | undefined,
  vehicleId: string,
  resumed: boolean,
  attachedIds: string[] | null,
  setAttachedIds: Dispatch<SetStateAction<string[] | null>>,
) {
  // FR-INS-062's default: seeded with EVERY member id, motive included (its
  // checkbox is disabled), or the driver's own truck renders as not-here.
  // Derived, not written back by an effect: it waits for the draft load,
  // which may narrow it.
  const seededIds = motive
    ? (motive.combination?.members.map((m) => m.vehicleId) ?? [motive.vehicleId])
    : null;
  const confirmedIds = attachedIds ?? (resumed ? seededIds : null);

  // One GET per confirmed unit, all of them at start while the driver still
  // has signal (FR-OFF-001). Each unit keeps its own configuration and its own
  // thresholds; only the walk-around numbering is projected across the rig.
  const memberIds = memberOrder(motive, confirmedIds, vehicleId);
  const memberQueries = useQueries({ queries: memberIds.map(captureContextQuery) });
  const loaded = memberQueries
    .map((q) => q.data)
    .filter((c): c is CaptureContext => c !== undefined);
  const contexts = loaded.length === memberIds.length && memberIds.length > 0 ? loaded : null;
  const membersFailed = memberQueries.some((q) => q.isError);

  function toggleAttached(id: string) {
    setAttachedIds((ids) => {
      const current = ids ?? seededIds ?? [vehicleId];
      return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    });
  }

  return { confirmedIds, seededIds, contexts, membersFailed, toggleAttached };
}

// Walk order, which is the combination's own sequence. The projection has to
// follow the physical rig, not the order a checkbox happened to be ticked in
// (FR-VEH-034). A unit with no combination is its own single member.
function memberOrder(
  motive: CaptureContext | undefined,
  attachedIds: string[] | null,
  vehicleId: string,
): string[] {
  if (attachedIds === null) return [];
  const members = motive?.combination?.members;
  if (!members) return [vehicleId];
  const ordered = [...members]
    .sort((a, b) => a.sequence - b.sequence)
    .map((m) => m.vehicleId)
    .filter((id) => attachedIds.includes(id));
  return ordered.length > 0 ? ordered : [vehicleId];
}
