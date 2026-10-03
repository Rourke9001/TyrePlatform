// NFR-USE-012: identifiers sort in natural order (TY10 after TY2), locale
// named rather than left to the runtime default. A module of its own: an
// export beside a component's would break react-refresh (queryKeys.ts
// holds the same note).
export function byNaturalCode(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
