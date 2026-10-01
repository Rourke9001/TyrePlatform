import type { ReactNode } from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ActorContext, failureOf } from "./actorContext";
import { fetchMe } from "./me";
import { ApiError } from "../api/apiError";
import { getDevTenantId } from "../api/devTenant";

export function ActorProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ["me", getDevTenantId() ?? "default"],
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
    // A 401 or a 403 answers the same on the next attempt, and a signed-out
    // driver must not wait through three retries to see the sign-in screen.
    retry: (failures, error) =>
      failures < 3 &&
      !(error instanceof ApiError && (error.status === 401 || error.status === 403)),
  });

  // !isPending, not isSuccess: a failed GET /api/me is settled too, and an
  // actor that cannot be resolved must still stop blocking a one-shot
  // routing decision rather than hanging on a spinner forever.
  const value = useMemo(
    () => ({
      actor: query.data ?? null,
      settled: !query.isPending,
      failure: failureOf(query.error),
    }),
    [query.data, query.isPending, query.error],
  );

  return <ActorContext value={value}>{children}</ActorContext>;
}
