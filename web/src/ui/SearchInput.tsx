import type { InputHTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { SearchIcon } from "./icons/Search";
import "./TextInput.css";
import "./SearchInput.css";

export interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "type"
> {
  // Required: a search field shows no visible label.
  label: string;
  size?: "md" | "glove";
  // Makes the frame a search landmark. Off by default, so a screen keeps
  // the landmarks it has today when a filter field moves onto this one.
  landmark?: boolean;
}

// className and the other props split as TextInput's do.
export function SearchInput({
  label,
  size = "md",
  landmark = false,
  className,
  ...rest
}: SearchInputProps) {
  return (
    <div
      className={cx("tr-input", size === "glove" && "tr-input--glove", className)}
      role={landmark ? "search" : undefined}
    >
      <Icon icon={SearchIcon} size={20} className="tr-input__lead" />
      <input {...rest} type="search" aria-label={label} />
    </div>
  );
}
