// Joins the class names that apply, so a component writes a conditional
// modifier without a template literal of empty strings.
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
