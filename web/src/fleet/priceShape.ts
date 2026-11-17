// U228: one shape for the three price fields. The typed text is tested,
// never converted, so money stays a string end to end (rule 2). A decimal
// comma is refused rather than read, since "1,234" could be either a
// thousands group or cents (spec, Lead's call 11). The database decides
// the amount; this only names a price it could not read.
export const PRICE_SHAPE = /^\d+(\.\d{1,2})?$/;

export const PRICE_SHAPE_ERROR =
  "Enter the price as digits with a point before the cents, for example 4319.91. Leave out spaces, commas and the currency sign.";

// A blank price is each form's own business, so only typed text is judged.
export function priceMisshapen(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && !PRICE_SHAPE.test(trimmed);
}
