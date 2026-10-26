// A tyre's condition against the tenant's configured thresholds. The
// thresholds are tenant data (rule 5); this only names the outcome, for
// every component that shows one.
export type Condition = "ok" | "near" | "limit" | "unread" | "nospare";
