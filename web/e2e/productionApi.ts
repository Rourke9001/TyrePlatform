import { type Page } from "@playwright/test";

// The API a production bundle calls, fulfilled here, since a production
// bundle has no dev header path and no real API runs beside vite preview
// (section 4 of docs/superpowers/specs/2026-10-16-platform-readiness-design.md).
// The second place an e2e file stubs, after idp.ts (web/CLAUDE.md).

export const TEST_API_ORIGIN = "https://api.test";

export interface ApiStub {
  // "<METHOD> <pathname> bearer" or "<METHOD> <pathname> none", in order.
  calls: string[];
}

// Only the fields the screens read. Declared here, not imported from ../src:
// that would pull token.ts's import.meta.env into this program, whose types
// have no vite/client.
interface Me {
  userId: string;
  displayName: string;
  role: string;
  capabilities: string[];
  depots: string[];
  scope: string;
  timezone: string;
  displayCodePolicy: string;
  tenantId: string;
}

interface Branding {
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
}

interface ExceptionsBody {
  scope: { level: string; depotCount: number; depot: string | null };
  judgedAt: string;
  exceptions: never[];
}

interface Depot {
  id: string;
  name: string;
  type: string;
}

const ME: Me = {
  userId: "0c0ffee0-0000-4000-8000-0000000000a1",
  displayName: "Production Check",
  role: "CONTROLLER",
  capabilities: ["ViewFleet"],
  depots: [],
  scope: "TENANT",
  timezone: "Africa/Johannesburg",
  displayCodePolicy: "FREE",
  tenantId: "0c0ffee0-0000-4000-8000-0000000000b1",
};

const BRANDING: Branding = {
  displayName: "Production Check",
  primaryColor: "#14586e",
  logoUrl: null,
};

const EXCEPTIONS: ExceptionsBody = {
  scope: { level: "TENANT", depotCount: 0, depot: null },
  judgedAt: "2026-10-16T08:00:00Z",
  exceptions: [],
};

const DEPOTS: Depot[] = [];

interface Task {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
}

const DRIVER_ME: Me = {
  ...ME,
  userId: "0c0ffee0-0000-4000-8000-0000000000a2",
  role: "DRIVER",
  capabilities: ["CaptureInspection"],
  scope: "DEPOT",
};

const TRAILER_ID = "0c0ffee0-0000-4000-8000-0000000000c1";

const TASKS: Task[] = [
  {
    id: "0c0ffee0-0000-4000-8000-0000000000d1",
    vehicleId: TRAILER_ID,
    fleetNumber: "PC-T1",
    dueAt: "2026-10-16T08:00:00Z",
    state: "OPEN",
    overdue: false,
  },
];

// A trailer, so the start screen asks for no odometer: one axle, two
// fitted positions and no spare.
const position = (n: number, side: "LEFT" | "RIGHT") => ({
  id: `0c0ffee0-0000-4000-8000-0000000000e${n}`,
  vehicleId: TRAILER_ID,
  code: String(n),
  sequence: n,
  axleClass: "TRAILER",
  axleType: "FIXED",
  side,
  axleNumber: 1,
  isSpare: false,
  unitLabel: null,
  tyreId: `0c0ffee0-0000-4000-8000-0000000000f${n}`,
  tyreCode: `PC-0${n}`,
  previousGoverningMm: null,
  previousReadingAt: null,
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
});

const CAPTURE_CONTEXT = {
  vehicleId: TRAILER_ID,
  fleetNumber: "PC-T1",
  registration: null,
  unitKind: "TRAILER",
  lastOdometerKm: null,
  lastOdometerAt: null,
  averageDailyKm: null,
  positions: [position(1, "LEFT"), position(2, "RIGHT")],
  combination: null,
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4.0,
    captureSpares: false,
  },
  cohortWearRateMmPerMonth: {},
};

const ROUTES: Record<string, unknown> = {
  "/api/me": ME,
  "/api/org/branding": BRANDING,
  "/api/exceptions": EXCEPTIONS,
  "/api/depots": DEPOTS,
  "/api/my/tasks": TASKS,
  [`/api/capture/vehicles/${TRAILER_ID}`]: CAPTURE_CONTEXT,
};

export async function stubProductionApi(
  page: Page,
  apiOrigin: string,
  webOrigin: string,
  actor: "controller" | "driver" = "controller",
): Promise<ApiStub> {
  const routes = actor === "driver" ? { ...ROUTES, "/api/me": DRIVER_ME } : ROUTES;
  const stub: ApiStub = { calls: [] };
  const cors = { "Access-Control-Allow-Origin": webOrigin };
  await page.route(
    (url) => url.origin === apiOrigin,
    (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const bearer = request.headers()["authorization"]?.startsWith("Bearer ") ? "bearer" : "none";
      stub.calls.push(`${request.method()} ${pathname} ${bearer}`);
      // Answered whether or not Playwright passes a preflight through.
      if (request.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            ...cors,
            "Access-Control-Allow-Methods": "GET, POST, PATCH",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        });
      }
      const body = request.method() === "GET" ? routes[pathname] : undefined;
      if (body === undefined) {
        return route.fulfill({
          status: 404,
          headers: cors,
          json: { code: "not_found", message: "no such endpoint" },
        });
      }
      return route.fulfill({ headers: cors, json: body });
    },
  );
  return stub;
}
