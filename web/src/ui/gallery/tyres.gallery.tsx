import { unitLabels } from "../../units/units";
import { AxleDiagram, type DiagramAxle, type DiagramUnit } from "../AxleDiagram";
import { Keypad } from "../Keypad";
import { TreadReadings, type TreadPressure } from "../TreadReadings";
import { TyreTile, type Condition } from "../TyreTile";
import type { GallerySection } from "./types";

// Sample strings only, shaped as capture passes them. The pressure word is
// the metric default's (FR-CFG-021); the tread word is capture's own.
const PRESSURE = unitLabels(undefined, undefined).pressure;
const MM = "mm";
const ignore = () => undefined;

// Static on purpose: a *.gallery.tsx exports a section object, so it may
// not declare a stateful demo component beside it
// (react-refresh/only-export-components).
const pressure = (value: string, active: boolean): TreadPressure => ({
  value,
  caption: "Press.",
  unitText: PRESSURE,
  ariaLabel: "Pressure",
  active,
  onSelect: ignore,
});

const TILES: { condition?: Condition; value: string; badge?: string }[] = [
  { condition: "ok", value: "13mm", badge: "OK" },
  { condition: "near", value: "6mm", badge: "Check" },
  { condition: "limit", value: "3mm", badge: "Report" },
  { condition: "unread", value: "—", badge: "Not done" },
  { condition: "nospare", value: "none", badge: "No spare" },
  { value: "11" },
];

const axle = (unit: string, id: string, label: string, numbers: number[]): DiagramAxle => ({
  id: `${unit}-${id}`,
  label,
  positions: numbers.map((n, i) => {
    const read = n % 4 !== 0;
    const near = n % 5 === 0;
    return {
      id: `${unit}:${n}`,
      label: String(n),
      valueText: read ? `${8 + ((n * 3) % 9)}mm` : "—",
      badgeText: read ? (near ? "Check" : "OK") : "Not done",
      condition: read ? (near ? "near" : "ok") : "unread",
      ariaLabel: `Position ${n}, ${unit}, axle ${id}, ${i < numbers.length / 2 ? "left" : "right"}`,
      dataPositionId: `${unit}-${n}`,
      active: n === 6,
    };
  }),
});

const RIG: DiagramUnit[] = [
  {
    id: "horse",
    unitHeading: "BAC039SP",
    description: "Horse",
    axles: [
      axle("BAC039SP", "1", "Steer", [1, 2]),
      axle("BAC039SP", "2", "Drive", [3, 4, 5, 6]),
      axle("BAC039SP", "3", "Drive", [7, 8, 9, 10]),
    ],
  },
  {
    id: "link6",
    unitHeading: "LINK6",
    description: "2-axle trailer",
    coupled: true,
    axles: [axle("LINK6", "1", "1", [11, 12, 13, 14]), axle("LINK6", "2", "2", [15, 16, 17, 18])],
  },
  {
    id: "spares",
    unitHeading: "BAC039SP spare",
    axles: [],
    spares: [
      {
        id: "BAC039SP:S",
        label: "S",
        valueText: "—",
        badgeText: "Not done",
        condition: "unread",
        ariaLabel: "Spare, BAC039SP, Not done",
        dataPositionId: "BAC039SP-S",
      },
    ],
  },
];

export const section: GallerySection = {
  id: "tyres",
  title: "Keypad, tread cells, tyre tiles and the rig",
  render: () => (
    <div className="tr-stack">
      <TreadReadings
        readings={["13", "13", ""]}
        governingIndex={null}
        activeIndex={2}
        onSelect={ignore}
        unitText={MM}
        pressure={pressure("", false)}
      />
      <Keypad onKey={ignore} goLabel="Next ›" ariaLabel="Number keypad" />
      <TreadReadings
        readings={["13", "12", "14"]}
        governingIndex={null}
        onSelect={ignore}
        unitText={MM}
        pressure={pressure("8", true)}
      />
      <Keypad onKey={ignore} altKey="half" goLabel="Seen it ›" goTone="warn" />
      <Keypad onKey={ignore} goLabel="Done ›" goDisabled />
      <TreadReadings
        readings={["12", "9", "14"]}
        governingIndex={1}
        governingText="Lowest"
        condition="near"
        unitText={MM}
      />
      <TreadReadings
        readings={["12", "9", "14"]}
        governingIndex={1}
        governingText="Lowest"
        condition="limit"
        naming="named"
        side="left"
        unitText={MM}
      />
      <TreadReadings readings={["11", "10", "", "9", "12"]} governingIndex={3} unitText={MM} />
      <div className="tr-cluster">
        {TILES.map((t, i) => (
          <div key={i} style={{ width: "72px" }}>
            <TyreTile
              numberText={String(i + 1)}
              valueText={t.value}
              badgeText={t.badge}
              condition={t.condition}
              selected={i === 0}
              onClick={ignore}
            />
          </div>
        ))}
        <div style={{ width: "72px" }}>
          <TyreTile numberText="7" empty ariaLabel="Position 7, no tyre fitted" />
        </div>
      </div>
      <AxleDiagram
        units={RIG}
        onSelect={ignore}
        frontLabel="Front"
        sideLabels={{ left: "Left", right: "Right" }}
        couplingLabel="Coupled"
      />
    </div>
  ),
};
