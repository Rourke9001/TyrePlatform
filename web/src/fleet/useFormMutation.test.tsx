import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type FormEvent } from "react";
import { describe, expect, it } from "vitest";

import { useFormMutation } from "./useFormMutation";
import { ApiError } from "../api/client";
import { refusalMessage } from "../api/refusal";
import { testQueryClient } from "../test/fixtures";

// A deferred whose executor assigns the resolver, released before the test
// ends (docs/lessons.md, 31 Aug 2026) — holds the mutation in flight long
// enough to assert the pending-disabled button, without a fake timer.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PROBE_WORDING = {
  speakable: ["TY999"],
  forbidden: "You do not have permission to do that.",
  fallback: "That could not be saved. Try again, or call support if it keeps happening.",
};

function ProbeForm({ mutate }: { mutate: (vars: { value: string }) => Promise<{ id: string }> }) {
  const [seen, setSeen] = useState<string | null>(null);
  const m = useFormMutation({
    mutate,
    invalidate: [["probe"]],
    onSuccess: (result) => setSeen(result.id),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    m.submit({ value: "x" });
  }

  return (
    <form onSubmit={submit}>
      <button type="submit" disabled={m.isPending}>
        {m.isPending ? "Saving…" : "Save"}
      </button>
      {m.error !== null && <p role="alert">{refusalMessage(m.error, PROBE_WORDING)}</p>}
      {seen && <p role="status">saved {seen}</p>}
    </form>
  );
}

// Reads the query client's own record of the invalidated key, rather than
// asserting on a spy on invalidateQueries: the probe cares that the cache
// entry for ["probe"] is marked stale, which is the observable effect a form
// actually depends on.
function InvalidationProbe() {
  const queryClient = useQueryClient();
  const [, forceRender] = useState(0);
  useEffect(
    () => queryClient.getQueryCache().subscribe(() => forceRender((n) => n + 1)),
    [queryClient],
  );
  const state = queryClient.getQueryState(["probe"]);
  return <p data-testid="invalidated">{String(state?.isInvalidated ?? false)}</p>;
}

function renderProbe(mutate: (vars: { value: string }) => Promise<{ id: string }>) {
  const client = testQueryClient();
  client.setQueryData(["probe"], { seeded: true });
  return render(
    <QueryClientProvider client={client}>
      <ProbeForm mutate={mutate} />
      <InvalidationProbe />
    </QueryClientProvider>,
  );
}

describe("useFormMutation", () => {
  it("disables the button while the mutation is pending", async () => {
    const { promise, resolve } = deferred<{ id: string }>();
    renderProbe(() => promise);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    resolve({ id: "p1" });
    await screen.findByText(/saved p1/i);
  });

  it("invalidates the given keys and calls onSuccess on success", async () => {
    renderProbe(() => Promise.resolve({ id: "p1" }));

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await screen.findByText(/saved p1/i);
    await waitFor(() => expect(screen.getByTestId("invalidated")).toHaveTextContent("true"));
  });

  it("renders a refusal through refusalMessage", async () => {
    renderProbe(() =>
      Promise.reject(new ApiError(422, "value is not one this fleet allows", "TY999")),
    );

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/value is not one this fleet/i);
  });

  it("falls back to the wording's generic message for an unrecognised refusal code", async () => {
    renderProbe(() => Promise.reject(new ApiError(500, "unrecognised", "boom")));

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/could not be saved/i);
  });
});
