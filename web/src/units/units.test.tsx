import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";
import { me } from "../test/fixtures";
import { unitLabels, useUnitLabels } from "./units";

const metric = { pressure: "kPa", distance: "km", distanceWord: "kilometres" };

describe("unitLabels", () => {
  it("labels the tenant's metric codes", () => {
    expect(unitLabels("KPA", "KM")).toEqual(metric);
  });
  // A code the module does not know is shown as itself, never relabelled
  // as kPa or km, so a figure is never captioned with a unit it is not.
  it("echoes a code it does not know", () => {
    expect(unitLabels("XKPA", "XKM")).toEqual({
      pressure: "XKPA",
      distance: "XKM",
      distanceWord: "XKM",
    });
  });
  // An API older than the web sends no codes, and the database admits only
  // metric (tenant_metric_units), so absent reads as metric, never as
  // "undefined".
  it("reads absent codes as metric", () => {
    expect(unitLabels(undefined, undefined)).toEqual(metric);
  });
});

describe("useUnitLabels", () => {
  function withActor(actor: Me | null) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActorContext.Provider value={{ actor, settled: true }}>{children}</ActorContext.Provider>
      );
    };
  }

  it("is metric with no actor", () => {
    const { result } = renderHook(() => useUnitLabels(), { wrapper: withActor(null) });
    expect(result.current).toEqual(metric);
  });

  it("follows the actor's tenant", () => {
    const { result } = renderHook(() => useUnitLabels(), {
      wrapper: withActor(me({ pressureUnit: "XKPA", distanceUnit: "XKM" })),
    });
    expect(result.current.pressure).toBe("XKPA");
    expect(result.current.distance).toBe("XKM");
  });
});
