import { severityLabel } from "../domain/vocabulary";
import { Badge } from "../ui/Badge";
import { SeverityBadge, type Severity } from "../ui/SeverityBadge";

const TONES: Readonly<Partial<Record<string, Severity>>> = {
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info",
};

// A wire severity with its glyph and tone (NFR-USE-009), in the
// vocabulary's word. A code the vocabulary does not know is still shown, in
// its own spelling, on a neutral badge rather than given a tone it lacks.
export function ExceptionSeverity({ code }: { code: string }) {
  const tone = TONES[code];
  return tone === undefined ? (
    <Badge>{severityLabel(code)}</Badge>
  ) : (
    <SeverityBadge severity={tone} label={severityLabel(code)} />
  );
}
