// Money over the wire is the exact decimal string the server sent, and it
// stays one (rule 2; web/CLAUDE.md). The brand makes that a type the lint
// rule can see, so house/money-stays-string can refuse Number(), arithmetic
// and the rest on it (spec U31, U37). The brand key is a plain property
// name because the rule looks it up by name through the type checker.
export type Money = string & { readonly __money: "rand" };

// A total is a SQL column, never a client sum (U31). Formatting is all the
// client does to money, and this does it without reading the value as a
// number: the string is split at the point and the integer part grouped.
export function formatRand(m: Money): string {
  const [whole, cents = "00"] = m.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}R${grouped}.${cents.padEnd(2, "0").slice(0, 2)}`;
}
