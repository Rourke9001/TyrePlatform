import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";

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
    invalidate: [["probe"], ["probe2"]],
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

// Reads the query client's own record of an invalidated key, rather than
// asserting on a spy on invalidateQueries: the probe cares that the cache
// entry is marked stale, which is the observable effect a form actually
// depends on. Parameterised over the key so the invalidation test can prove
// every key in the list is invalidated, not just the first.
function InvalidationProbe({ testId, queryKey }: { testId: string; queryKey: string }) {
  const queryClient = useQueryClient();
  const [, forceRender] = useState(0);
  useEffect(
    () => queryClient.getQueryCache().subscribe(() => forceRender((n) => n + 1)),
    [queryClient],
  );
  const state = queryClient.getQueryState([queryKey]);
  return <p data-testid={testId}>{String(state?.isInvalidated ?? false)}</p>;
}

function renderProbe(mutate: (vars: { value: string }) => Promise<{ id: string }>) {
  const client = testQueryClient();
  client.setQueryData(["probe"], { seeded: true });
  client.setQueryData(["probe2"], { seeded: true });
  return render(
    <QueryClientProvider client={client}>
      <ProbeForm mutate={mutate} />
      <InvalidationProbe testId="invalidated" queryKey="probe" />
      <InvalidationProbe testId="invalidated2" queryKey="probe2" />
    </QueryClientProvider>,
  );
}

// TVars/TResult = void: the shape the 204 writes have (removeFitment,
// setUnitStatus, logRetreadReturn, returnTyreToStock) — an endpoint whose only
// observable outcome is isSuccess, since `result` stays permanently null for
// them.
function VoidProbeForm({ mutate }: { mutate: (vars: { value: string }) => Promise<void> }) {
  const m = useFormMutation<{ value: string }, void>({
    mutate,
    invalidate: [],
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
      <p data-testid="success">{String(m.isSuccess)}</p>
      <p data-testid="result">{String(m.result)}</p>
      {m.error !== null && <p role="alert">{refusalMessage(m.error, PROBE_WORDING)}</p>}
    </form>
  );
}

function renderVoidProbe(mutate: (vars: { value: string }) => Promise<void>) {
  const client = testQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <VoidProbeForm mutate={mutate} />
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

  it("invalidates every given key and calls onSuccess on success", async () => {
    renderProbe(() => Promise.resolve({ id: "p1" }));

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await screen.findByText(/saved p1/i);
    await waitFor(() => expect(screen.getByTestId("invalidated")).toHaveTextContent("true"));
    expect(screen.getByTestId("invalidated2")).toHaveTextContent("true");
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

  // TanStack does not dedupe: without useFormMutation's own guard, a second
  // submit reaching the handler while the first is still in flight would
  // fire a second write. The button's disabled attribute already stops a
  // real second click, so this bypasses it — fireEvent.submit on the form
  // itself, the way a stray Enter-key resubmission or a second
  // form.requestSubmit() would — to prove the hook's guard, not the DOM, is
  // what holds a fitment or rotation write to one event (rule 3).
  //
  // The assertion sits after the awaited findByText, not right after the
  // second fireEvent.submit: TanStack's own execute() yields at its
  // onMutate await before ever reaching mutationFn, so a synchronous read
  // immediately after fireEvent.submit reads 1 whether or not the guard
  // exists — it is checking a call that has not had a chance to happen yet,
  // guarded or not. Only once every microtask this test's own `promise`
  // resolution can trigger has drained — which findByText's wait forces —
  // would an unguarded second execute() have reached the spy.
  it("fires one request for two submits inside one pending window", async () => {
    const { promise, resolve } = deferred<{ id: string }>();
    const mutate = vi.fn(() => promise);
    const { container } = renderProbe(mutate);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mutate).toHaveBeenCalledTimes(1);

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);

    resolve({ id: "p1" });
    await screen.findByText(/saved p1/i);

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  // result stays permanently null for a Promise<void> mutation (nothing to
  // show back from a 204), so isSuccess is what NFR-USE-010's explicit
  // success renders from for those forms.
  it("marks isSuccess true and keeps result null for a void mutation", async () => {
    renderVoidProbe(() => Promise.resolve());

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByTestId("success")).toHaveTextContent("true"));
    expect(screen.getByTestId("result")).toHaveTextContent("null");
  });

  // A fresh submit is a new mutation, not a continuation of the failed one —
  // isSuccess must read false for the whole pending window, never briefly
  // true off the previous attempt's state before the new result lands.
  it("keeps isSuccess false while a fresh submit is pending after an earlier error", async () => {
    const { promise, resolve } = deferred<void>();
    const mutate = vi
      .fn<(vars: { value: string }) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(500, "boom", "boom"))
      .mockReturnValueOnce(promise);
    renderVoidProbe(mutate);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await screen.findByRole("alert");
    expect(screen.getByTestId("success")).toHaveTextContent("false");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    expect(screen.getByTestId("success")).toHaveTextContent("false");

    resolve();
    await waitFor(() => expect(screen.getByTestId("success")).toHaveTextContent("true"));
  });
});
