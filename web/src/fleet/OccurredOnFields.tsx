import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
import { isEarlierDay } from "./occurredOn";

// The day a movement happened and, when asked, why it is recorded late
// (FR-FIT-016 as amended). Empty is today, as on the rig form.
export function OccurredOnFields({
  idPrefix,
  day,
  onDay,
  why,
  onWhy,
  today,
  ask,
}: {
  idPrefix: string;
  day: string;
  onDay: (day: string) => void;
  why: string;
  onWhy: (why: string) => void;
  today: string;
  ask: boolean;
}) {
  return (
    <>
      <Field label="Occurred on" hint="Leave empty for today.">
        <TextInput
          id={`${idPrefix}-occurred-on`}
          type="date"
          max={today}
          value={day}
          onChange={(e) => onDay(e.target.value)}
        />
      </Field>
      {ask && (
        <Field label="Why it is recorded late">
          <TextInput
            id={`${idPrefix}-why`}
            value={why}
            onChange={(e) => onWhy(e.target.value)}
            required={isEarlierDay(day, today)}
          />
        </Field>
      )}
    </>
  );
}
