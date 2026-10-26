import { Checkbox } from "../Checkbox";
import { Field } from "../Field";
import { SearchInput } from "../SearchInput";
import { Select } from "../Select";
import { TextArea } from "../TextArea";
import { TextInput } from "../TextInput";
import { ChoiceDemo } from "./forms.demo";
import type { GallerySection } from "./types";

// Example words only, in the Sandbox tenant's voice. No unit word: a
// screen takes those from useUnitLabels() (FR-CFG-021).
const rules = [
  { value: "LOW_TREAD", label: "Low tread" },
  { value: "OVERDUE", label: "Inspection overdue" },
];

export const section: GallerySection = {
  id: "forms",
  title: "Forms: fields, inputs and choices",
  render: () => (
    <div className="tr-stack">
      <Field label="Fleet number" hint="As painted on the cab">
        <TextInput mono placeholder="SBX-01" />
      </Field>
      <Field label="Spares carried" error="Enter a whole number">
        <TextInput suffix="tyres" defaultValue="two" />
      </Field>
      <Field label="Order reference" optional>
        <TextInput prefix="PO" size="glove" />
      </Field>
      <Field label="Rule">
        <Select options={rules} placeholder="Any rule" defaultValue="" />
      </Field>
      <SearchInput label="Find a tyre" placeholder="Serial or fleet number" />
      <Field label="Notes" optional>
        <TextArea placeholder="What the driver saw" />
      </Field>
      <Checkbox label="Include replaced" />
      <Checkbox
        label="Valve caps fitted"
        description="All positions"
        variant="card"
        defaultChecked
      />
      <ChoiceDemo />
    </div>
  ),
};
