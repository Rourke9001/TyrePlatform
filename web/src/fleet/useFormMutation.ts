import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

export interface UseFormMutationOptions<TVars, TResult> {
  mutate: (vars: TVars) => Promise<TResult>;
  // Every cache entry this write makes stale, invalidated together: a
  // form writing under a unit and under the fleet-wide register stays
  // correct with one list, not two calls that could drift.
  invalidate: QueryKey[];
  onSuccess?: (result: TResult) => void;
}

export interface UseFormMutationResult<TVars, TResult> {
  submit: (vars: TVars) => void;
  isPending: boolean;
  // Separate from `result`, which stays null for a Promise<void> mutation
  // (a 204 carries nothing back): isSuccess is what such a form renders
  // NFR-USE-010's explicit success from.
  isSuccess: boolean;
  error: unknown;
  result: TResult | null;
}

// The row/screen forms' shared shape: field state and the onSubmit guard
// stay with the caller, the mutation/invalidation/refusalMessage plumbing
// is one implementation. The hook renders nothing; wording stays in each
// form's own JSX.
export function useFormMutation<TVars, TResult>(
  options: UseFormMutationOptions<TVars, TResult>,
): UseFormMutationResult<TVars, TResult> {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: options.mutate,
    onSuccess: (result) => {
      for (const key of options.invalidate) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      options.onSuccess?.(result);
    },
  });

  return {
    // TanStack does not dedupe concurrent calls; a fitment or rotation
    // write is an event, immutable once recorded (rule 3), so this guard,
    // not the disabled button alone (one render behind the click), is
    // what stops a second tap becoming a second event.
    submit: (vars: TVars) => {
      if (mutation.isPending) return;
      mutation.mutate(vars);
    },
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    error: mutation.error,
    result: mutation.data ?? null,
  };
}
