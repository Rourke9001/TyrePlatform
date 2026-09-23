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

// Headless Radix, styled by the tokens: the keyboard, typeahead and
// screen-reader behaviour is theirs, the look is ours (ADR-0015). A native
// select would do on desktop and misbehave on iOS with long lists.
export function Select({ id, value, onValueChange, options, placeholder, ...rest }: SelectProps) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange}>
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
            {options.map((o) => (
              <RadixSelect.Item key={o.value} value={o.value} className="select-item">
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="select-indicator" aria-hidden="true">
                  *
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
