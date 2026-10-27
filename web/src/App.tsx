import { AuthGate } from "./auth/AuthGate";
import { AppRoutes } from "./routes";
import { Chrome } from "./shell/Chrome";
import { RouteErrorBoundary } from "./shell/RouteErrorBoundary";

// One application, one deployment: the management interface and the driver
// capture interface are routes within it, not separate apps (IR-UI-001).
export function App() {
  return (
    <Chrome>
      <AuthGate>
        <RouteErrorBoundary>
          <AppRoutes />
        </RouteErrorBoundary>
      </AuthGate>
    </Chrome>
  );
}
