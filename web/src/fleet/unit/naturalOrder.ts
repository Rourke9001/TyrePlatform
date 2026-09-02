// NFR-USE-012: identifiers sort in natural order, so TY10 follows TY2 rather
// than preceding it. The locale is named rather than left to the runtime's
// default, because a picker's order must not depend on the machine the
// browser happens to run on.
//
// A module of its own, not a helper beside the screen that sorts: an export
// from a file that also exports a component is what react-refresh's
// only-export-components rule refuses (queryKeys.ts holds the same note).
export function byNaturalCode(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
