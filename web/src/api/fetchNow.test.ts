import { onlineManager } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { testQueryClient } from "../test/fixtures";
import { fetchNow } from "./fetchNow";

// TYRE-340: the premises the escalated retry rests on, pinned at the library.
describe("fetchNow", () => {
  it("fetches an entry seeded with initialData that has never fetched, which refetchQueries skips", async () => {
    const client = testQueryClient();
    const queryFn = vi.fn(() => Promise.resolve("fresh"));
    await client.ensureQueryData({
      queryKey: ["k"],
      queryFn,
      initialData: "seed",
      staleTime: Infinity,
    });
    await client.refetchQueries({ queryKey: ["k"] });
    expect(queryFn).not.toHaveBeenCalled();

    await fetchNow(client, { queryKey: ["k"], queryFn });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(["k"])).toBe("fresh");
  });

  it("keeps the copy when the fetch fails, and does not reject", async () => {
    const client = testQueryClient();
    client.setQueryData(["k"], "copy");

    await expect(
      fetchNow(client, { queryKey: ["k"], queryFn: () => Promise.reject(new Error("no signal")) }),
    ).resolves.toBeUndefined();

    expect(client.getQueryData(["k"])).toBe("copy");
    expect(client.getQueryState(["k"])?.status).toBe("error");
  });

  // Offline the fetch pauses until signal returns; waiting on it would hold
  // the error screen for nothing.
  it("does not wait on a fetch that pauses offline", async () => {
    const client = testQueryClient();
    client.setQueryData(["k"], "copy");
    onlineManager.setOnline(false);
    try {
      await expect(
        fetchNow(client, { queryKey: ["k"], queryFn: () => Promise.resolve("fresh") }),
      ).resolves.toBeUndefined();
      expect(client.getQueryState(["k"])?.fetchStatus).toBe("paused");
      expect(client.getQueryData(["k"])).toBe("copy");
    } finally {
      onlineManager.setOnline(true);
    }
  });
});
