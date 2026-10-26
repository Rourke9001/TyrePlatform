import type { InputHTMLAttributes } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { Search } from "./icons/Search";
import "./TextInput.css";
import "./SearchInput.css";

export interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "type"
> {
  // Required: a search field shows no visible label.
  label: string;
  size?: "md" | "glove";
}

// className styles the frame, which is the search landmark; every other
// prop reaches the input.
export function SearchInput({ label, size = "md", className, ...rest }: SearchInputProps) {
  return (
    <div className={cx("tr-input", size === "glove" && "tr-input--glove", className)} role="search">
      <Icon icon={Search} size={20} className="tr-input__lead" />
      <input {...rest} type="search" aria-label={label} />
    </div>
  );
}
