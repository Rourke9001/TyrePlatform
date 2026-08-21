import { useBranding } from "./theme/ThemeProvider";
import { statusColor, type TreadBandName } from "./theme/tokens";
import "./App.css";

// Band labels are display strings for the FIXED band names (tokens.ts).
// Which mm reading falls in which band is tenant configuration decided
// server-side (rule 5) — the web only ever receives a band name.
const bandLabel: Record<TreadBandName, string> = {
  roadworthy: "Roadworthy",
  caution: "Caution",
  "below-removal": "Below removal",
  unmeasured: "Unmeasured",
};

// Theme demonstration surface for TYRE-27; the dashboard shell (TYRE-28)
// replaces it. Everything here reads custom properties — it is the render
// used to verify default vs tenant branding against the seeded tenants.
export function App() {
  const { branding } = useBranding();

  return (
    <main className="demo">
      <p className="demo-eyebrow">Fleet tyre platform</p>
      <h1 className="demo-wordmark">{branding.displayName}</h1>
      <div className="demo-row">
        <button className="demo-primary" type="button">
          Start inspection
        </button>
        <span className="demo-fleet">BAC039SP</span>
      </div>
      <ul className="demo-bands">
        {(Object.keys(bandLabel) as TreadBandName[]).map((band) => (
          <li key={band} className="demo-band">
            <span
              className="demo-band-dot"
              style={{ background: statusColor[band] }}
              aria-hidden="true"
            />
            {bandLabel[band]}
          </li>
        ))}
      </ul>
    </main>
  );
}
