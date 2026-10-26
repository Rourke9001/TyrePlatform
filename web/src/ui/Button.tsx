import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

import { cx } from "./cx";
import { Icon, type IconGlyph } from "./Icon";
import "./Button.css";

interface ButtonLook {
  // primary is the one thing the screen is for, in the tenant's brand
  // (U53); danger destroys data and sits only inside a Dialog.
  variant?: "primary" | "secondary" | "ghost" | "danger";
  // NFR-USE-004: md is the 44px floor, glove the 56px every driver-route
  // control takes.
  size?: "md" | "lg" | "glove";
  icon?: IconGlyph;
  iconEnd?: IconGlyph;
  block?: boolean;
  className?: string;
  children?: ReactNode;
}

type LookKey = keyof ButtonLook;

export type ButtonAsButton = ButtonLook &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, LookKey> & {
    to?: undefined;
    loading?: boolean;
  };

// An in-app route renders a router Link with the button's look. A link
// cannot be disabled, so a caller that needs a disabled state renders the
// button form.
export type ButtonAsLink = ButtonLook & Omit<LinkProps, LookKey>;

export type ButtonProps = ButtonAsButton | ButtonAsLink;

function lookClass({ variant = "secondary", size = "md", block, className }: ButtonLook): string {
  return cx(
    "tr-btn",
    `tr-btn--${variant}`,
    size !== "md" && `tr-btn--${size}`,
    block && "tr-btn--block",
    className,
  );
}

function Content({
  icon,
  iconEnd,
  size,
  loading,
  children,
}: Pick<ButtonLook, "icon" | "iconEnd" | "size" | "children"> & { loading?: boolean }) {
  const iconSize = size === "glove" ? 22 : 20;
  return (
    <>
      {loading ? (
        <span className="tr-btn__spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon icon={icon} size={iconSize} />
      ) : null}
      <span>{children}</span>
      {iconEnd && !loading ? <Icon icon={iconEnd} size={iconSize} /> : null}
    </>
  );
}

export function Button(props: ButtonProps) {
  if (props.to !== undefined) {
    const { variant, size, icon, iconEnd, block, className, children, ...rest } = props;
    return (
      <Link {...rest} className={lookClass({ variant, size, block, className })}>
        <Content icon={icon} iconEnd={iconEnd} size={size}>
          {children}
        </Content>
      </Link>
    );
  }
  // type="button" by default: a button inside a form submits it unless told
  // otherwise.
  const {
    variant,
    size,
    icon,
    iconEnd,
    block,
    className,
    children,
    loading,
    type = "button",
    disabled,
    ...rest
  } = props;
  return (
    <button
      {...rest}
      type={type}
      className={lookClass({ variant, size, block, className })}
      disabled={disabled === true || loading === true}
      aria-busy={loading ? true : undefined}
    >
      <Content icon={icon} iconEnd={iconEnd} size={size} loading={loading}>
        {children}
      </Content>
    </button>
  );
}
