import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTyreCatalogue } from "./catalogue";
import { respond } from "../test/fixtures";

describe("fetchTyreCatalogue", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the catalogue in one GET and hands back its three lists as sent", async () => {
    const body = {
      sizes: [{ id: "s1", name: "315/80R22.5" }],
      brands: [],
      patterns: [{ id: "p1", name: "SP431", brandId: null, appliesTo: "NEW" }],
    };
    vi.mocked(fetch).mockResolvedValue(respond(200, body));

    const catalogue = await fetchTyreCatalogue();

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/tyre-catalogue");
    expect(init?.method).toBe("GET");
    expect(catalogue).toEqual(body);
  });
});
