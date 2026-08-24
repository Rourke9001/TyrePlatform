import type { ReactNode } from "react";

import { useCan } from "./actorContext";

// Presentation only. The server refuses the request whatever the client
// renders (NFR-SEC-006), so this hides silently rather than explaining —
// telling someone what they may not do is not information they asked for.
export function RequireCapability({
  capability,
  children,
}: {
  capability: string;
  children: ReactNode;
}) {
  return useCan(capability) ? <>{children}</> : null;
}
