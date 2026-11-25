import { describe, expect, it } from "vitest";

import { roleLabel } from "./roles";

describe("roleLabel", () => {
  it("names the six roles and passes an unknown one through", () => {
    expect(roleLabel("DRIVER")).toBe("Driver");
    expect(roleLabel("TECHNICIAN")).toBe("Technician");
    expect(roleLabel("CONTROLLER")).toBe("Controller");
    expect(roleLabel("DEPOT_MANAGER")).toBe("Depot manager");
    expect(roleLabel("ORG_ADMIN")).toBe("Organisation admin");
    expect(roleLabel("PLATFORM_ADMIN")).toBe("Platform admin");
    expect(roleLabel("AUDITOR")).toBe("AUDITOR");
  });
});
