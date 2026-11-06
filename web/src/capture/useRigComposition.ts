import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { useActor } from "../auth/actorContext";
import type { CaptureContext } from "./captureContext";
import { captureContextQuery } from "./captureContext";

interface Held {
  vehicleId: string;
  units: ReadonlyMap<string, CaptureContext>;
}

// Owns the rig's composition (FR-INS-062/063): which member units are
// confirmed attached, the GETs over them, the toggle, and the held contexts
// (U186). attachedIds is state the caller owns (CaptureFlow), since the
// draft's load effect and discard also write it.
export function useRigComposition(
  motive: CaptureContext | undefined,
  vehicleId: string,
  resumed: boolean,
  attachedIds: string[] | null,
  setAttachedIds: Dispatch<SetStateAction<string[] | null>>,
  startedAt: string | undefined,
  holding: boolean,
  draftStartedAt: string | undefined,
) {
  // U186: past Start, the contexts the walk-around and the review read are
  // held here. The map is read only off the start screen and for the vehicle
  // it was taken for, so a discard or a vehicle change reads none of it. A
  // Start replaces it, and so does the first hold for another vehicle.
  const [held, setHeld] = useState<Held | null>(null);
  const units = holding && held?.vehicleId === vehicleId ? held.units : null;
  // The member list is frozen with the held motive, so a renewal that
  // changes the combination does not drop a unit mid-walk-around (U186).
  const shownMotive = units?.get(vehicleId) ?? motive;

  // FR-INS-062's default: seeded with EVERY member id, motive included (its
  // checkbox is disabled), or the driver's own truck renders as not-here.
  // Derived, not written back by an effect: it waits for the draft load,
  // which may narrow it.
  const seededIds = shownMotive
    ? (shownMotive.combination?.members.map((m) => m.vehicleId) ?? [shownMotive.vehicleId])
    : null;
  const confirmedIds = attachedIds ?? (resumed ? seededIds : null);

  // One GET per confirmed unit, all of them at start while the driver still
  // has signal (FR-OFF-001). Each unit keeps its own configuration and its own
  // thresholds; only the walk-around numbering is projected across the rig.
  const memberIds = memberOrder(shownMotive, confirmedIds, vehicleId);
  // The motive's own window, so its query and its member query share a key.
  const client = useQueryClient();
  const timeZone = useActor()?.timezone ?? "UTC";
  const memberQueries = useQueries({
    queries: memberIds.map((id) => captureContextQuery(id, startedAt, client, timeZone)),
  });

  // Every unit with data now, keeping base's entry where it has one.
  function take(base: ReadonlyMap<string, CaptureContext> | null) {
    const taken = new Map<string, CaptureContext>();
    if (motive !== undefined) taken.set(vehicleId, motive);
    for (const [i, id] of memberIds.entries()) {
      const data = memberQueries[i].data;
      if (data !== undefined) taken.set(id, data);
    }
    return new Map([...taken, ...(base ?? [])]);
  }

  // U186: past Start, a unit with nothing held for this vehicle yet, a
  // resumed draft's, a first load that lands after the tap, or any unit after
  // a vehicle change, is held on the first render that has its data.
  if (holding) {
    const next = take(units);
    if (next.size > (units?.size ?? 0)) setHeld({ vehicleId, units: next });
  }

  // U186 to Done: a remount in this tab resumes through the draft's window,
  // so each held context seeds that key's entry when there is none.
  // Built from the full options, so it keeps gcTime Infinity while nothing
  // observes it.
  useEffect(() => {
    if (units === null || draftStartedAt === undefined) return;
    for (const [id, ctx] of units) {
      void client
        .ensureQueryData({
          ...captureContextQuery(id, draftStartedAt, client, timeZone),
          initialData: ctx,
        })
        .catch(() => undefined);
    }
  }, [units, draftStartedAt, client, timeZone]);

  // In memberIds' order, the combination's sequence, not the order units were
  // held in (FR-VEH-034).
  const loaded = memberIds
    .map((id, i) => units?.get(id) ?? memberQueries[i].data)
    .filter((c): c is CaptureContext => c !== undefined);
  const contexts = loaded.length === memberIds.length && memberIds.length > 0 ? loaded : null;
  // The first failure's error, so a refusal is told apart from lost signal.
  // A member with a copy, kept by a failed renewal (U179) or held (U186), has
  // not failed.
  const membersError =
    memberQueries.find((q, i) => q.isError && q.data === undefined && !units?.has(memberIds[i]))
      ?.error ?? null;
  // A member's earlier-day copy is renewing, as the motive's can be. A first
  // load has no copy to hold back, so the start screen does not wait on it.
  const membersRefreshing = memberQueries.some(
    (q) => q.data !== undefined && q.isStale && q.isFetching,
  );
  // A member with a copy has not failed (U179), so the reload asks again only
  // for those that failed with none.
  const refetchMembers = () => {
    for (const q of memberQueries) if (q.isError && q.data === undefined) void q.refetch();
  };

  // U186: held at the tap, not when the screen leaves Start, since that waits
  // on the draft write (useDraftLifecycle).
  function hold() {
    setHeld({ vehicleId, units: take(null) });
  }

  function toggleAttached(id: string) {
    setAttachedIds((ids) => {
      const current = ids ?? seededIds ?? [vehicleId];
      return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    });
  }

  return {
    confirmedIds,
    seededIds,
    contexts,
    heldMotive: units?.get(vehicleId),
    membersError,
    membersRefreshing,
    refetchMembers,
    toggleAttached,
    hold,
  };
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
