import { Route, Routes } from "react-router";

import { VehicleList } from "./dashboard/VehicleList";

function NotFound() {
  return <p>Not found.</p>;
}

// The route table. Capability guards arrive with the actor context; until
// then every route is reachable, which is why the API refuses rather than
// relying on the client hiding anything (NFR-SEC-006).
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<VehicleList />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
