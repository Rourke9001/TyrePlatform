import { describe, expect, it } from "vitest";

import { NAV_ITEMS, navItemsFor } from "./navigation";

describe("navItemsFor", () => {
  // A DRIVER holds exactly CaptureInspection (api/internal/auth/auth.go), and
  // the whole point of the shell is that their one destination is not buried
  // in a manager's menu.
  it("gives a driver exactly their own destinations", () => {
    const items = navItemsFor(["CaptureInspection"]);
    expect(items.map((i) => i.to)).toEqual(["/my"]);
  });

  it("gives a tenant-wide actor every destination they hold", () => {
    const admin = [
      "ViewFleet",
      "CaptureInspection",
      "ManageAssignments",
      "ManageAssets",
      "LogRetread",
      "ViewValuation",
      "ManageConfig",
      "ManageUsers",
    ];
    expect(navItemsFor(admin)).toEqual([...NAV_ITEMS]);
  });

  it("renders nothing for an actor with no capabilities", () => {
    expect(navItemsFor([])).toEqual([]);
  });

  // The server owns the capability vocabulary (web/src/auth/me.ts). A client
  // that crashed on a capability it had not heard of would break on deploy
  // ordering rather than degrade, so an unknown string is simply ignored.
  it("ignores a capability it has no destination for", () => {
    expect(navItemsFor(["SomethingAddedLater"])).toEqual([]);
  });

  // Menu order is a product decision, not an accident of Array.filter over
  // whatever order the server happened to serialise capabilities in.
  it("keeps registry order regardless of the order capabilities arrive in", () => {
    const forward = navItemsFor(["ViewFleet", "CaptureInspection"]);
    const reversed = navItemsFor(["CaptureInspection", "ViewFleet"]);
    expect(forward).toEqual(reversed);
  });

  it("offers the admin screens only to the capabilities that can use them", () => {
    const assets = navItemsFor(["ViewFleet", "ManageAssets"]).map((i) => i.to);
    expect(assets).toContain("/admin/units/new");
    expect(assets).not.toContain("/admin/users/new");

    const users = navItemsFor(["ViewFleet", "ManageUsers"]).map((i) => i.to);
    expect(users).toContain("/admin/users/new");

    // A driver holds neither, and the menu is a courtesy — the route checks
    // again regardless (NFR-SEC-006).
    expect(navItemsFor(["CaptureInspection"]).map((i) => i.to)).toEqual(["/my"]);
  });
});
