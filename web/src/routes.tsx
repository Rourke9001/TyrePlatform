import { Navigate, Route, Routes } from "react-router";

import { useActorSettled, useCan } from "./auth/actorContext";
import { RequireCapability } from "./auth/RequireCapability";
import { DriverHome } from "./driver/DriverHome";
import { VehicleList } from "./dashboard/VehicleList";

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
      <Route path="/my" element={<DriverHome />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
