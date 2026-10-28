// app.side is LEFT or RIGHT, and null on a spare (000001). Anything else is
// left unset, so AxleDiagram splits that axle by count rather than by a side
// nobody sent. One mapping for the vehicle screen and capture (ADR-0022).
export function diagramSide(side: string | null): "left" | "right" | undefined {
  if (side === "LEFT") return "left";
  if (side === "RIGHT") return "right";
  return undefined;
}
