import { AppShell } from "./dashboard/AppShell";
import { VehicleList } from "./dashboard/VehicleList";

// The manager dashboard (FR-DSH-001). The driver capture PWA (TYRE-4,
// ADR-0009) is a separate mount and does not exist yet.
export function App() {
  return (
    <AppShell>
      <VehicleList />
    </AppShell>
  );
}
