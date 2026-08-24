import { AppShell } from "./dashboard/AppShell";
import { AppRoutes } from "./routes";

// One application, one deployment: the management interface and the driver
// capture interface are routes within it, not separate apps (IR-UI-001).
export function App() {
  return (
    <AppShell>
      <AppRoutes />
    </AppShell>
  );
}
