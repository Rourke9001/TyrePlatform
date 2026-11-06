// U55: every displayed number groups thousands with a comma, written here
// once. It takes an integer's digits, optionally signed, as a string, so
// formatMoney groups a Money value without reading it as a number (rule 2);
// a fraction is the caller's to split off first.
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// A decimal figure with its whole part grouped and its fraction as written,
// for a value that may carry one, such as a capture warning's stored figure.
export function groupWhole(value: string): string {
  const point = value.indexOf(".");
  if (point < 0) return groupThousands(value);
  return groupThousands(value.slice(0, point)) + value.slice(point);
}
