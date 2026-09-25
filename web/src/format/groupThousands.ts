// U55: every displayed number groups thousands with a comma, as money does.
// This is the one place the separator is written. It takes an integer's
// digits, optionally signed, as a string, so formatRand groups a Money value
// without reading it as a number (rule 2); a fraction is the caller's to
// split off first. It imports nothing, so the capture route pays only for it.
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
