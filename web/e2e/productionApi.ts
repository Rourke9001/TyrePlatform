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

const ROUTES: Record<string, unknown> = {
  "/api/me": ME,
  "/api/org/branding": BRANDING,
  "/api/exceptions": EXCEPTIONS,
  "/api/depots": DEPOTS,
};

export async function stubProductionApi(
  page: Page,
  apiOrigin: string,
  webOrigin: string,
): Promise<ApiStub> {
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
      const body = request.method() === "GET" ? ROUTES[pathname] : undefined;
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
