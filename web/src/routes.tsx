import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router";

import { useActorSettled, useCan, useCanAny } from "./auth/actorContext";
import { RequireCapability } from "./auth/RequireCapability";
import { CaptureFlow } from "./capture/CaptureFlow";
import { DriverHome } from "./driver/DriverHome";

// Every manager page loads on its own route and never on the capture
// route's first paint (ADR-0015, TYRE-238). CaptureFlow and DriverHome stay
// static: a lazy fetch in front of the driver's flow is the round trip
// ADR-0009 avoids. scripts/check-capture-bundle.mjs fails on a module under
// src/capture/ or src/driver/ made lazy, and on an entry over its budget.
const AddDriver = lazy(() => import("./admin/AddDriver").then((m) => ({ default: m.AddDriver })));
const AddUnit = lazy(() => import("./admin/AddUnit").then((m) => ({ default: m.AddUnit })));
const VehicleList = lazy(() =>
  import("./dashboard/VehicleList").then((m) => ({ default: m.VehicleList })),
);
const FitmentList = lazy(() =>
  import("./fleet/FitmentList").then((m) => ({ default: m.FitmentList })),
);
const RetreadQueue = lazy(() =>
  import("./fleet/RetreadQueue").then((m) => ({ default: m.RetreadQueue })),
);
const ReceiveTyre = lazy(() =>
  import("./fleet/ReceiveTyre").then((m) => ({ default: m.ReceiveTyre })),
);
const RigsScreen = lazy(() =>
  import("./fleet/rigs/RigsScreen").then((m) => ({ default: m.RigsScreen })),
);
const TyreList = lazy(() =>
  import("./fleet/tyres/TyreList").then((m) => ({ default: m.TyreList })),
);
const UnitDetail = lazy(() =>
  import("./fleet/unit/UnitDetail").then((m) => ({ default: m.UnitDetail })),
);

function NotFound() {
  return <p>Not found.</p>;
}

// FR-DSH-001/FR-DSH-012: a driver has no fleet view to land on, and the redirect is
// one-shot since a capability check reads false before GET /api/me answers
// and cannot revise itself later.
function Landing() {
  const settled = useActorSettled();
  const canViewFleet = useCan("ViewFleet");
  if (!settled) return null;
  return canViewFleet ? <Navigate to="/fleet" replace /> : <Navigate to="/my" replace />;
}

// FR-INS-048's one tap into the work. The vehicle is in the path and the task
// is a query parameter because an inspection can be started off a task or off
// the vehicle alone (FR-INS-049). The same screen, with or without a task to
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

// D7's unit screen refuses out loud (a destination someone navigated to),
// unlike /fleet and /fleet/fitments, which stay hidden per D7.
export function UnitRoute() {
  const { unitId } = useParams();
  if (!unitId) return <NotFound />;
  return <UnitDetail unitId={unitId} />;
}

// A destination someone navigated to says why it is refused; a menu item
// just disappears (RequireCapability). capability accepts a bare string or
// array; rules-of-hooks forbids branching per shape at the call site, so
// this normalises before the one hook call (D9, ADR-0011).
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

// The gallery imports Radix, so it loads behind a lazy boundary and never
// on the capture route (ADR-0015). DEV only, and the lazy() call itself is
// guarded so a production build emits no gallery chunk at all.
const Gallery = import.meta.env.DEV ? lazy(() => import("./ui/Gallery")) : null;

export function AppRoutes() {
  return (
    <Suspense
      fallback={
        <p className="route-loading" role="status">
          Loading.
        </p>
      }
    >
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
          path="/fleet/rigs"
          element={
            <RequireCapability capability="ViewFleet">
              <RigsScreen />
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
            <AdminRoute capability="ViewFleet">
              <UnitRoute />
            </AdminRoute>
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
        {/* The catch-all is written in both branches so a production build,
            where Gallery is null, folds this to that one route and leaves
            nothing behind in the entry chunk the capture budget gates. */}
        {Gallery ? (
          <>
            <Route path="/dev/design" element={<Gallery />} />
            <Route path="*" element={<NotFound />} />
          </>
        ) : (
          <Route path="*" element={<NotFound />} />
        )}
      </Routes>
    </Suspense>
  );
}
