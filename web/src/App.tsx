import { AppShell } from "./dashboard/AppShell";
import { VehicleList } from "./dashboard/VehicleList";

// The manager dashboard (FR-DSH-001). The driver capture PWA mounts
// separately once OI-28 unblocks the capture screen (TYRE-12).
export function App() {
  return (
    <AppShell>
      <VehicleList />
    </AppShell>
  );
}
