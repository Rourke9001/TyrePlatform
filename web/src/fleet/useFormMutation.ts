import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

export interface UseFormMutationOptions<TVars, TResult> {
  mutate: (vars: TVars) => Promise<TResult>;
  // Every cache entry this write makes stale, invalidated together on
  // success — a form that writes under a unit and under the fleet-wide
  // register both stays correct with one list, not two separate calls a
  // future edit could let drift apart.
  invalidate: QueryKey[];
  onSuccess?: (result: TResult) => void;
}

export interface UseFormMutationResult<TVars, TResult> {
  submit: (vars: TVars) => void;
  isPending: boolean;
  error: unknown;
  result: TResult | null;
}

// The row- and screen-level forms' shared shape: field state and the
// `<form onSubmit>` guard stay with the caller (a field's own emptiness rule
// differs per form), while the mutation, the invalidation loop and the error
// a screen hands to refusalMessage are one implementation. The hook renders
// nothing — the `role="alert"` line stays in each form's own JSX, so a
// screen's wording stays with the screen rather than migrating into shared
// code no one reading the form would find it in.
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
    submit: (vars: TVars) => mutation.mutate(vars),
    isPending: mutation.isPending,
    error: mutation.error,
    result: mutation.data ?? null,
  };
}
