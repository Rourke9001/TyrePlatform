// U55: every displayed number groups thousands with a comma, written here
// once. It takes an integer's digits, optionally signed, as a string, so
// formatRand groups a Money value without reading it as a number (rule 2);
// a fraction is the caller's to split off first.
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
