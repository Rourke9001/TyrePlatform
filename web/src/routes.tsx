import type { ReactNode } from "react";
import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router";

import { useActorSettled, useCan, useCanAny } from "./auth/actorContext";
import { RequireCapability } from "./auth/RequireCapability";
import { AddDriver } from "./admin/AddDriver";
import { AddUnit } from "./admin/AddUnit";
import { CaptureFlow } from "./capture/CaptureFlow";
import { DriverHome } from "./driver/DriverHome";
import { VehicleList } from "./dashboard/VehicleList";
import { FitmentList } from "./fleet/FitmentList";
import { RetreadQueue } from "./fleet/RetreadQueue";
import { ReceiveTyre } from "./fleet/ReceiveTyre";
import { TyreList } from "./fleet/tyres/TyreList";
import { UnitDetail } from "./fleet/unit/UnitDetail";

function NotFound() {
  return <p>Not found.</p>;
}

// FR-DSH-001 / FR-DSH-012: the landing view follows the role. A driver has no
// fleet view to land on, and sending them to one they would be refused is a
// worse first impression than sending them to their work. Nothing is rendered
// until the actor resolves: a capability check reads false before GET /api/me
// answers, and this redirect is one-shot — it cannot revise itself later.
function Landing() {
  const settled = useActorSettled();
  const canViewFleet = useCan("ViewFleet");
  if (!settled) return null;
  return canViewFleet ? <Navigate to="/fleet" replace /> : <Navigate to="/my" replace />;
}

// FR-INS-048's one tap into the work. The vehicle is in the path and the task
// is a query parameter because an inspection can be started off a task or off
// the vehicle alone (FR-INS-049) — the same screen, with or without a task to
// close.
function CaptureRoute() {
  const { vehicleId } = useParams();
  const [params] = useSearchParams();
  const can = useCan("CaptureInspection");
  const settled = useActorSettled();
  if (!settled) return null;
  // A blank screen is not NFR-USE-005. RequireCapability hides silently,
  // which is right for a menu item and wrong for a destination someone
  // navigated to.
  if (!can) return <p role="alert">You do not have permission to capture inspections.</p>;
  if (!vehicleId) return <NotFound />;
  return <CaptureFlow vehicleId={vehicleId} taskId={params.get("taskId")} />;
}

// D7's unit screen is a ViewFleet read, hidden like /fleet rather than
// refused out loud (RequireCapability wraps this at the call site, not
// here). A param segment never matches empty, so this guard covers
// UnitDetail's non-empty-id contract, not a reachable URL — CaptureRoute's
// shape, for the same reason.
export function UnitRoute() {
  const { unitId } = useParams();
  if (!unitId) return <NotFound />;
  return <UnitDetail unitId={unitId} />;
}

// A destination someone navigated to says why it is refused; a menu item just
// disappears. RequireCapability is the second, so these routes are the first.
//
// capability accepts a bare string or an array so a caller with one
// capability need not wrap it, but useCanAny needs the fixed-arity array
// form — rules-of-hooks forbids calling useCan conditionally per shape at
// this call site — so this normalises before the one hook call. See
// useCanAny's doc comment (auth/actorContext.ts) for why a route needs an
// any-of gate at all (D9, ADR-0011).
function AdminRoute({
  capability,
  children,
}: {
  capability: string | readonly string[];
  children: ReactNode;
}) {
  const can = useCanAny(typeof capability === "string" ? [capability] : capability);
  const settled = useActorSettled();
  if (!settled) return null;
  if (!can) return <p role="alert">You do not have permission to use this screen.</p>;
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/fleet"
        element={
          <RequireCapability capability="ViewFleet">
            <VehicleList />
          </RequireCapability>
        }
      />
      <Route
        path="/fleet/tyres"
        element={
          <AdminRoute capability="ManageAssets">
            <TyreList />
          </AdminRoute>
        }
      />
      <Route
        path="/fleet/tyres/new"
        element={
          <AdminRoute capability="ManageAssets">
            <ReceiveTyre />
          </AdminRoute>
        }
      />
      <Route
        path="/fleet/tyres/retreads"
        element={
          <AdminRoute capability="LogRetread">
            <RetreadQueue />
          </AdminRoute>
        }
      />
      <Route
        path="/fleet/units/:unitId"
        element={
          <RequireCapability capability="ViewFleet">
            <UnitRoute />
          </RequireCapability>
        }
      />
      <Route
        path="/fleet/fitments"
        element={
          <RequireCapability capability="ViewFleet">
            <FitmentList />
          </RequireCapability>
        }
      />
      <Route path="/my" element={<DriverHome />} />
      <Route path="/capture/:vehicleId" element={<CaptureRoute />} />
      <Route
        path="/admin/units/new"
        element={
          <AdminRoute capability="ManageAssets">
            <AddUnit />
          </AdminRoute>
        }
      />
      <Route
        path="/admin/users/new"
        element={
          <AdminRoute capability={["ManageUsers", "InviteDriver"]}>
            <AddDriver />
          </AdminRoute>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
