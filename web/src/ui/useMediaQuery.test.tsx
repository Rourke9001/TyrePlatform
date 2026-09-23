import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestMediaQueryList } from "../test/media";
import { PHONE_QUERY, useMediaQuery, usePhone } from "./useMediaQuery";

describe("useMediaQuery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches at the width dashboard.css switches at", () => {
    expect(PHONE_QUERY).toBe("(max-width: 640px)");
  });

  it("reads the query's current answer", () => {
    const list = new TestMediaQueryList(PHONE_QUERY, true);
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue(list);
    const { result } = renderHook(() => useMediaQuery(PHONE_QUERY));
    expect(result.current).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(PHONE_QUERY);
  });

  it("re-renders when the answer changes", () => {
    const list = new TestMediaQueryList(PHONE_QUERY, false);
    vi.spyOn(window, "matchMedia").mockReturnValue(list);
    const { result } = renderHook(() => usePhone());
    expect(result.current).toBe(false);
    act(() => {
      list.change(true);
    });
    expect(result.current).toBe(true);
  });
});
