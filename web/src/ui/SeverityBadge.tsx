import { severityLabel } from "./vocabulary";

// Three glyphs so the badge reads in greyscale and to a colour-blind
// reader (NFR-USE-009); the word is the encoding and the glyph is
// decoration, so it is hidden from assistive tech.
const GLYPH: Record<string, string> = {
  INFO: "i",
  WARNING: "!",
  CRITICAL: "!!",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className="severity-badge" data-severity={severity}>
      <span className="severity-glyph" aria-hidden="true">
        {GLYPH[severity] ?? "?"}
      </span>
      {severityLabel(severity)}
    </span>
  );
}
