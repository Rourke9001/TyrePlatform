import { useId, type ReactNode } from "react";
import { Link } from "react-router";

interface StatTileProps {
  label: string;
  value: ReactNode;
  // What the figure is not, or what it is made of: "of which 9 audit",
  // "3 unscheduled". NFR-PRO-002: a figure states its own provenance.
  qualifier?: ReactNode;
  // The clock it is judged at, from judgedAtLabel (U18, U48).
  judged?: string;
  to?: string;
  linkLabel?: string;
  // The FR id the tile answers, reachable by e2e as data-requirement
  // (web/CLAUDE.md: the one data- attribute exception).
  requirement?: string;
  tone?: "default" | "critical" | "warning";
  // The label nests under the heading the tile sits beneath: 3 below a
  // Panel's h2, 2 directly under a page's h1.
  headingLevel?: 2 | 3 | 4;
}

export function StatTile({
  label,
  value,
  qualifier,
  judged,
  to,
  linkLabel = "See the list",
  requirement,
  tone = "default",
  headingLevel = 3,
}: StatTileProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <article
      className={`stat-tile stat-tile-${tone}`}
      aria-labelledby={headingId}
      data-requirement={requirement}
    >
      <Heading id={headingId} className="stat-label">
        {label}
      </Heading>
      <p className="stat-value">{value}</p>
      {/* A div, not a p: a qualifier may carry a list or a split (block
          content), and React refuses a block inside a paragraph. */}
      {qualifier && <div className="stat-qualifier">{qualifier}</div>}
      {judged && <p className="stat-judged">{judged}</p>}
      {to && (
        <Link className="stat-link" to={to}>
          {linkLabel}
        </Link>
      )}
    </article>
  );
}
