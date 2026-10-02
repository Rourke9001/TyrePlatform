import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ActorContext, failureOf, type AuthFailure } from "./actorContext";
import { fetchMe } from "./me";
import { retryQuery } from "../api/apiError";
import { getDevTenantId } from "../api/devTenant";

export function ActorProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ["me", getDevTenantId() ?? "default"],
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
    retry: retryQuery,
  });

  // Spec section 4: a failure that settled with no actor holds until /api/me
  // returns data. A later refetch that fails on the network is not an answer,
  // and must not drop the sign-in screen onto routes with no actor. Adjusted
  // during render, the documented way to derive state from a changing value.
  const named = failureOf(query.error);
  const [held, setHeld] = useState<AuthFailure>(null);
  if (query.data !== undefined) {
    if (held !== null) setHeld(null);
  } else if (named !== null && named !== held) {
    setHeld(named);
  }

  // !isPending, not isSuccess: a failed GET /api/me is settled too, and an
  // actor that cannot be resolved must still stop blocking a one-shot
  // routing decision rather than hanging on a spinner forever.
  const value = useMemo(
    () => ({
      actor: query.data ?? null,
      // A refetch of an errored query reads pending again, so a held failure
      // stays settled.
      settled: !query.isPending || held !== null,
      failure: named ?? held,
    }),
    [query.data, query.isPending, named, held],
  );

  return <ActorContext value={value}>{children}</ActorContext>;
}
