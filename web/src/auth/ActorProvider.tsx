import type { ReactNode } from "react";
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

  return <ActorContext value={query.data ?? null}>{children}</ActorContext>;
}
