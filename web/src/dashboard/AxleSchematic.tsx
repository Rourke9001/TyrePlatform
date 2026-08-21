// The design system's signature motif: a vehicle in plan view, position
// pairs as rounded rects (TYRE-28). Decorative until later slices colour
// positions by live band status, hence aria-hidden and currentColor — the
// row sets the colour, the motif never encodes information on its own
// (NFR-USE-009).
export function AxleSchematic() {
  return (
    <svg
      className="axle-schematic"
      viewBox="0 0 64 28"
      width="64"
      height="28"
      aria-hidden="true"
    >
      <line x1="6" y1="14" x2="58" y2="14" stroke="currentColor" strokeWidth="1.5" />
      {/* steer axle: singles */}
      <line x1="10" y1="6" x2="10" y2="22" stroke="currentColor" strokeWidth="1.5" />
      <rect x="6" y="2" width="8" height="4" rx="2" fill="currentColor" />
      <rect x="6" y="22" width="8" height="4" rx="2" fill="currentColor" />
      {/* drive axles: duals */}
      {[38, 52].map((x) => (
        <g key={x}>
          <line x1={x} y1="6" x2={x} y2="22" stroke="currentColor" strokeWidth="1.5" />
          <rect x={x - 4} y="1" width="8" height="4" rx="2" fill="currentColor" />
          <rect x={x - 4} y="6" width="8" height="4" rx="2" fill="currentColor" />
          <rect x={x - 4} y="18" width="8" height="4" rx="2" fill="currentColor" />
          <rect x={x - 4} y="23" width="8" height="4" rx="2" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}
