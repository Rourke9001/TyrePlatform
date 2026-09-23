import * as RadixSelect from "@radix-ui/react-select";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

// Radix's Root reserves value="" to mean no selection and shows the
// placeholder, so an option whose own value is "" (TYRE-239's "All depots")
// needs a stand-in value Radix will treat as a real item.
//
// A space cannot collide: SelectOption.value is always an id or code
// (depot id, position code, ...), and none of those carry whitespace.
const EMPTY_VALUE_SENTINEL = "__select empty__";

// Headless Radix, styled by the tokens: the keyboard, typeahead and
// screen-reader behaviour is theirs, the look is ours (ADR-0015). A native
// select would do on desktop and misbehave on iOS with long lists.
export function Select({ id, value, onValueChange, options, placeholder, ...rest }: SelectProps) {
  const hasEmptyOption = options.some((o) => o.value === "");
  const rootValue = value === "" && hasEmptyOption ? EMPTY_VALUE_SENTINEL : value;
  const handleValueChange = (next: string) => {
    onValueChange(next === EMPTY_VALUE_SENTINEL ? "" : next);
  };
  return (
    <RadixSelect.Root value={rootValue} onValueChange={handleValueChange}>
      <RadixSelect.Trigger
        id={id}
        className="select-trigger"
        aria-label={rest["aria-label"]}
        aria-describedby={rest["aria-describedby"]}
        aria-invalid={rest["aria-invalid"]}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="select-icon" aria-hidden="true">
          v
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="select-content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport className="select-viewport">
            {options.map((o) => {
              const itemValue = o.value === "" ? EMPTY_VALUE_SENTINEL : o.value;
              return (
                <RadixSelect.Item key={itemValue} value={itemValue} className="select-item">
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="select-indicator" aria-hidden="true">
                    *
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              );
            })}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
