import { useState } from "react";

import { ChoiceChips } from "../ChoiceChips";
import { SegmentedControl } from "../SegmentedControl";

const periods = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

const causes = [
  { value: "cut", label: "Cut" },
  { value: "bulge", label: "Bulge" },
  { value: "uneven", label: "Uneven wear" },
  { value: "other", label: "Something else" },
];

// Both radio groups are controlled, so the sample holds their state and a
// reviewer can click and arrow through them.
export function ChoiceDemo() {
  const [period, setPeriod] = useState("month");
  const [cause, setCause] = useState<string | null>(null);
  return (
    <>
      <SegmentedControl label="Period" options={periods} value={period} onChange={setPeriod} />
      <ChoiceChips label="Damage" options={causes} value={cause} onChange={setCause} size="glove" />
    </>
  );
}
