import "./capture.css";

// The plan-view tyre the three fields sit under (D-A, TYRE-147,
// FR-INS-029a/FR-CFG-024): only the centreline moves between sides; the
// reading digits are numbered left to right regardless of side.
export function TreadGlyph({ side, count }: { side: "LEFT" | "RIGHT"; count: number }) {
  const label = `Tyre from above, ${side === "LEFT" ? "left" : "right"} side of the vehicle; readings 1 to ${count} run left to right`;
  const step = 60 / count;
  return (
    <svg className="cap-glyph" role="img" aria-label={label} data-side={side} viewBox="0 0 100 40">
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
      {/* The vehicle centreline: right of the tyre for LEFT (nearest the
          vehicle's middle from that side), left of the tyre for RIGHT. This
          is the only thing that differs between the two sides. */}
      <line
        x1={side === "RIGHT" ? 8 : 92}
        y1="0"
        x2={side === "RIGHT" ? 8 : 92}
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
        >
          {i + 1}
        </text>
      ))}
    </svg>
  );
}
