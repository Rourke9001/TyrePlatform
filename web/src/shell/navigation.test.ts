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

  // D9 split the invite in two: CONTROLLER and DEPOT_MANAGER hold
  // InviteDriver and not ManageUsers, and the whole point of the split is
  // that they see "Add a user" too, without also seeing "Add a unit"
  // (ADR-0011).
  it("offers add-a-user, but not add-a-unit, to an actor holding InviteDriver alone", () => {
    const items = navItemsFor(["InviteDriver"]).map((i) => i.to);
    expect(items).toContain("/admin/users/new");
    expect(items).not.toContain("/admin/units/new");
  });

  // TYRE-91: the fleet vocabulary is Units · Tyres · Rigs · Fitments.
  it("labels the /fleet entry Units, not Vehicles", () => {
    const fleet = navItemsFor(["ViewFleet"]).find((i) => i.to === "/fleet");
    expect(fleet?.label).toBe("Units");
  });

  // Tyres is gated on ManageAssets, a capability distinct from the ViewFleet
  // that governs Units itself — holding one must not imply the other, so
  // this actor sees Units and nothing else.
  it("shows Units without Tyres to an actor who can view the fleet but not manage assets", () => {
    const items = navItemsFor(["ViewFleet"]).map((i) => i.to);
    expect(items).toContain("/fleet");
    expect(items).not.toContain("/fleet/tyres");
  });

  it("shows Tyres, labelled and gated on ManageAssets, to an actor who holds it", () => {
    const tyres = navItemsFor(["ViewFleet", "ManageAssets"]).find((i) => i.to === "/fleet/tyres");
    expect(tyres?.label).toBe("Tyres");
    expect(tyres?.capability).toBe("ManageAssets");
  });

  // A CONTROLLER sees both; a DRIVER — holding only CaptureInspection — sees
  // neither Units nor its Tyres sibling.
  it("gives a controller both Units and Tyres, and a driver neither", () => {
    const controller = navItemsFor(["ViewFleet", "ManageAssets"]).map((i) => i.to);
    expect(controller).toContain("/fleet");
    expect(controller).toContain("/fleet/tyres");

    const driver = navItemsFor(["CaptureInspection"]).map((i) => i.to);
    expect(driver).not.toContain("/fleet");
    expect(driver).not.toContain("/fleet/tyres");
  });

  // D7: Fitments is a ViewFleet read like Units, not gated on ManageAssets —
  // a reader who cannot manage a tyre can still see what is fitted where.
  // TYRE-72: Rigs joins them as a third ViewFleet read, between Tyres and
  // Fitments in registry order.
  it("gives a ViewFleet holder Units, Rigs and Fitments, and nothing else", () => {
    const labels = navItemsFor(["ViewFleet"]).map((i) => i.label);
    expect(labels).toEqual(["Units", "Rigs", "Fitments"]);
  });

  // U2: rig reads gate on ViewFleet like the rest of the fleet register.
  it("gives a ViewFleet holder the Rigs destination", () => {
    const rigs = navItemsFor(["ViewFleet"]).find((i) => i.to === "/fleet/rigs");
    expect(rigs?.label).toBe("Rigs");
    expect(rigs?.capability).toBe("ViewFleet");
  });

  // A controller holds ManageAssets as well as ViewFleet, so Tyres joins the
  // menu — registry order puts Rigs between Tyres and Fitments regardless of
  // which capability let each item in.
  it("keeps Tyres, Rigs and Fitments in registry order for a ManageAssets holder", () => {
    const labels = navItemsFor(["ViewFleet", "ManageAssets"])
      .map((item) => item.label)
      .filter((label) => ["Tyres", "Rigs", "Fitments"].includes(label));
    expect(labels).toEqual(["Tyres", "Rigs", "Fitments"]);
  });

  // Retreads is gated on LogRetread alone: it is the alert-on-refusal admin
  // surface (AdminRoute), not the hide-silently ViewFleet read Fitments
  // shares with Units.
  it("gives a LogRetread holder Retreads alone", () => {
    const labels = navItemsFor(["LogRetread"]).map((i) => i.label);
    expect(labels).toEqual(["Retreads"]);
  });

  // ManageAssets alone, without ViewFleet, must not surface Units — Tyres
  // and its own Add-a-unit gate are independent of the fleet read.
  it("gives a ManageAssets holder Tyres and Add a unit, without Units", () => {
    const labels = navItemsFor(["ManageAssets"]).map((i) => i.label);
    expect(labels).toEqual(["Tyres", "Add a unit"]);
  });
});
