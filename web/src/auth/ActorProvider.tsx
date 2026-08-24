import type { ReactNode } from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ActorContext } from "./actorContext";
import { fetchMe } from "./me";
import { getDevTenantId } from "../api/devTenant";

export function ActorProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ["me", getDevTenantId() ?? "default"],
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
  });

  // !isPending, not isSuccess: a failed GET /api/me is settled too, and an
  // actor that cannot be resolved must still stop blocking a one-shot
  // routing decision rather than hanging on a spinner forever.
  const value = useMemo(
    () => ({ actor: query.data ?? null, settled: !query.isPending }),
    [query.data, query.isPending],
  );

  return <ActorContext value={value}>{children}</ActorContext>;
}
