import { refusalMessage, type RefusalWording } from "../api/refusal";

// The row/screen forms' shared refusal shape: an ApiError rendered through
// its screen's own wording, or a plain locally-raised message. Renders
// nothing when there is no error/empty string, so a caller can mount this
// unconditionally rather than guarding it itself (TYRE-260).
export function RefusalAlert(
  props: { error: unknown; wording: RefusalWording } | { message: string },
) {
  const text = "message" in props ? props.message : errorText(props.error, props.wording);
  if (text === "") return null;
  return <p role="alert">{text}</p>;
}

function errorText(error: unknown, wording: RefusalWording): string {
  return error === null ? "" : refusalMessage(error, wording);
}
