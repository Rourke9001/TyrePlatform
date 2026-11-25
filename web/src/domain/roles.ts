// FR-AUT-002's roles in words. Here, not vocabulary.ts: the static frame in
// the capture entry shows the signed-in role, and that entry may not import
// vocabulary.ts (web/CLAUDE.md, the wire-code rule). A role the server adds
// before this list does shows as its code.
const ROLE_LABELS: Record<string, string> = {
  DRIVER: "Driver",
  TECHNICIAN: "Technician",
  CONTROLLER: "Controller",
  DEPOT_MANAGER: "Depot manager",
  ORG_ADMIN: "Organisation admin",
  PLATFORM_ADMIN: "Platform admin",
};

export function roleLabel(code: string): string {
  return ROLE_LABELS[code] ?? code;
}
