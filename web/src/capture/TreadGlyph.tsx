import "./capture.css";

// The plan-view tyre the three fields sit under (decision D-A, TYRE-147). The
// driver never sees the words inner or outer (FR-CFG-024); what they see is
// the tyre from above with the readings numbered the way the fields are, and
// the vehicle's centreline drawn on the side it is actually on — so "left to
// right" means the same thing on both sides of the truck. A RIGHT-side tyre
// is the LEFT one mirrored; nothing else differs.
export function TreadGlyph({ side, count }: { side: "LEFT" | "RIGHT"; count: number }) {
  const label = `Tyre from above, ${side === "LEFT" ? "left" : "right"} side of the vehicle; readings ${1} to ${count} run left to right`;
  const step = 60 / count;
  return (
    <svg
      className="cap-glyph"
      role="img"
      aria-label={label}
      data-side={side}
      viewBox="0 0 100 40"
      // The vehicle centreline: on the right of a LEFT tyre, on the left of a
      // RIGHT one. Drawn as the mirror rather than two pictures.
      style={{ transform: side === "RIGHT" ? "scaleX(-1)" : undefined }}
    >
      <rect
        x="20"
        y="6"
        width="60"
        height="28"
        rx="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
      <line
        x1="92"
        y1="0"
        x2="92"
        y2="40"
        stroke="currentColor"
        strokeWidth="3"
        strokeDasharray="4 3"
      />
      {Array.from({ length: count }, (_, i) => (
        <text
          key={i}
          x={20 + step * i + step / 2}
          y="25"
          textAnchor="middle"
          fontSize="12"
          fill="currentColor"
          // Un-mirror the digit so it reads the right way round on a RIGHT tyre.
          style={{
            transform: side === "RIGHT" ? "scaleX(-1)" : undefined,
            transformOrigin: `${20 + step * i + step / 2}px 25px`,
          }}
        >
          {i + 1}
        </text>
      ))}
    </svg>
  );
}
