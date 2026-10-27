import { useId, useState, type CSSProperties } from "react";

import { AppShell, type NavGroup } from "../AppShell";
import { Dialog } from "../Dialog";
import { DriverShell } from "../DriverShell";
import { ListRow } from "../ListRow";
import { PageHeader } from "../PageHeader";
import { Sheet } from "../Sheet";
import { TabPanel } from "../TabPanel";
import { Tabs } from "../Tabs";
import { Routed } from "./routed";

// Invented round figures in the Sandbox tenant's voice, none taken from a
// fixture or a fleet.

// A positioned, contained box: an inline overlay, a sticky bar and the
// drawer stay inside it instead of covering the page.
const frame: CSSProperties = {
  position: "relative",
  height: 420,
  overflow: "auto",
  contain: "layout",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-md)",
};

const label: CSSProperties = { margin: 0, fontWeight: 700 };

const nav: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/" },
      { label: "Exceptions", to: "/exceptions", count: 7, critical: true },
    ],
  },
  { label: "Development", items: [{ label: "Design gallery", to: "/dev/design" }] },
];

function TabsSample() {
  const id = useId();
  const [value, setValue] = useState("tyres");
  const items = [
    { value: "tyres", label: "Tyres", count: 6 },
    { value: "inspections", label: "Inspections", count: 14 },
    { value: "events", label: "Events", count: 2, critical: true },
  ].map((t) => ({ ...t, id: `${id}-tab-${t.value}`, panelId: `${id}-panel-${t.value}` }));
  return (
    <div>
      <Tabs label="Sample vehicle" items={items} value={value} onChange={setValue} />
      {items.map((t) => (
        <TabPanel key={t.value} id={t.panelId} labelledBy={t.id} active={t.value === value}>
          <p>{t.label} for TRK-01 would list here.</p>
        </TabPanel>
      ))}
    </div>
  );
}

function OverlaySamples() {
  const [sheet, setSheet] = useState<"bottom" | "right" | null>(null);
  const [dialog, setDialog] = useState(false);
  return (
    <div style={frame}>
      <div className="tr-cluster" style={{ padding: "var(--space-4)" }}>
        <button type="button" onClick={() => setSheet("bottom")}>
          Open the bottom sheet
        </button>
        <button type="button" onClick={() => setSheet("right")}>
          Open the side sheet
        </button>
        <button type="button" onClick={() => setDialog(true)}>
          Open the dialog
        </button>
      </div>
      <Sheet
        inline
        open={sheet !== null}
        side={sheet ?? "bottom"}
        onClose={() => setSheet(null)}
        eyebrow="TRK-01 · position 3"
        title="Tyre T-104"
        description="Fitted 12 Oct 2026, read today."
        footer={
          <button type="button" onClick={() => setSheet(null)}>
            Done
          </button>
        }
      >
        <p>Tab stays inside the sheet; Escape closes it and focus goes back.</p>
      </Sheet>
      <Dialog
        inline
        open={dialog}
        onClose={() => setDialog(false)}
        tone="danger"
        title="Discard this inspection?"
        description="The readings on this phone are deleted. Nothing has been sent."
        actions={
          <>
            <button type="button" onClick={() => setDialog(false)}>
              Keep it
            </button>
            <button type="button" onClick={() => setDialog(false)}>
              Discard
            </button>
          </>
        }
      />
    </div>
  );
}

// One track no wider than the gallery column, so a wide sample scrolls
// inside itself (the shells' content grids do the same).
const column: CSSProperties = { gridTemplateColumns: "minmax(0, 1fr)" };

export function LayoutSamples() {
  return (
    <Routed>
      <div className="tr-stack" style={column}>
        <PageHeader
          eyebrow="Fleet"
          title="Exceptions"
          description="What needs a person, judged at each unit's latest inspection."
          back={{ label: "Dashboard", to: "/" }}
          actions={<button type="button">Refresh</button>}
        />
        <TabsSample />
        <p style={label}>Sheet, docked: no scrim, no trap, the rig stays reachable</p>
        <Sheet
          modal={false}
          open
          title="Position 3"
          ariaLabel="Sample position 3"
          description="TRK-01 · steer"
          onClose={() => undefined}
          footer={<button type="button">Next position</button>}
        >
          <p>The keypad and tread cells sit here.</p>
        </Sheet>
        <p style={label}>Sheets and dialog, modal</p>
        <OverlaySamples />
        <p style={label}>Manager shell</p>
        <div style={frame}>
          <AppShell
            nav={nav}
            brand={<strong>Sandbox Fleet</strong>}
            scope="All depots"
            actor="Sandbox Manager · CONTROLLER"
            signOut={<button type="button">Sign out</button>}
            devBar={<p>Dev bar</p>}
          >
            <PageHeader title="Dashboard" />
            <p>The page sits here.</p>
          </AppShell>
        </div>
        <p style={label}>Driver shell</p>
        <div style={frame}>
          <DriverShell
            brand={<strong>SF</strong>}
            barTitle="Sandbox Fleet"
            actor="Sandbox Driver · DRIVER"
            signOut={<button type="button">Sign out</button>}
            status={
              <p style={{ margin: 0, padding: "var(--space-2) var(--space-4)" }}>
                Nothing waiting to send
              </p>
            }
            title="My inspections"
            footer={<button type="button">Start inspection</button>}
          >
            <ul className="tr-list">
              <li>
                <ListRow to="/dev/design">TRK-01, due 27 Oct</ListRow>
              </li>
              <li>
                <ListRow>TRL-02</ListRow>
              </li>
            </ul>
          </DriverShell>
        </div>
      </div>
    </Routed>
  );
}
