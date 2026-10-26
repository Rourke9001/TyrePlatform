import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { NavLink } from "react-router";

import { formatCount } from "../format/numbers";
import { cx } from "./cx";
import "./AppShell.css";

// TODO(TYRE-447): move to src/ui/icons/ when lane A lands
function MenuGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </svg>
  );
}

export interface NavItem {
  label: string;
  to: string;
  icon?: ReactNode;
  // Beside the label: open exceptions, retreads due back.
  count?: number;
  critical?: boolean;
  // NavLink's exact match, on by default: the paths nest, and a prefix
  // match would mark every ancestor current at once (NFR-USE-005).
  end?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export interface AppShellProps extends HTMLAttributes<HTMLDivElement> {
  // Filtered by the actor's capabilities before it gets here; hiding an
  // item is a courtesy, never the boundary (NFR-SEC-006).
  nav: NavGroup[];
  brand?: ReactNode;
  // Beside the brand: the depot scope.
  scope?: ReactNode;
  // Who the app thinks is asking, as one string, so it reads as one line.
  actor?: string;
  signOut?: ReactNode;
  // Right of the top bar, before the actor.
  topbar?: ReactNode;
  // The outbox (ADR-0009): under the bar, ahead of everything a screen draws.
  status?: ReactNode;
  signIn?: ReactNode;
  // TYRE-242: after the content, never in the header.
  devBar?: ReactNode;
  menuLabel?: string;
  children?: ReactNode;
}

export function AppShell({
  nav,
  brand,
  scope,
  actor,
  signOut,
  topbar,
  status,
  signIn,
  devBar,
  menuLabel = "Menu",
  className,
  children,
  ...rest
}: AppShellProps) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  const groupId = useId();
  const groups = nav.filter((g) => g.items.length > 0);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setOpen(false);
      menu.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className={cx("tr-shell", className)} data-open={open ? "true" : undefined} {...rest}>
      <header className="tr-shell__top">
        {groups.length > 0 ? (
          <button
            ref={menu}
            type="button"
            className="tr-shell__menu"
            aria-label={menuLabel}
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen((was) => !was)}
          >
            <MenuGlyph />
          </button>
        ) : null}
        {brand || scope ? (
          <div className="tr-shell__org">
            {brand}
            {scope ? <span className="tr-shell__scope">{scope}</span> : null}
          </div>
        ) : null}
        <span className="tr-shell__spacer" />
        {topbar ? <div className="tr-shell__tools">{topbar}</div> : null}
        {actor ? <p className="tr-shell__actor">{actor}</p> : null}
        {signOut}
      </header>
      {status}
      {signIn}
      <div className={cx("tr-shell__frame", groups.length === 0 && "tr-shell__frame--bare")}>
        {groups.length > 0 ? (
          <>
            {open ? <div className="tr-shell__scrim" onClick={() => setOpen(false)} /> : null}
            <div className="tr-shell__side" id={drawerId}>
              <nav aria-label="Main" className="tr-shell__nav">
                {groups.map((group, gi) => {
                  const labelId = `${groupId}-${gi}`;
                  return (
                    <div key={group.label ?? gi} className="tr-shell__group">
                      {group.label ? (
                        <p id={labelId} className="tr-shell__group-label">
                          {group.label}
                        </p>
                      ) : null}
                      <ul
                        className="tr-shell__items"
                        aria-labelledby={group.label ? labelId : undefined}
                      >
                        {group.items.map((item) => (
                          <li key={item.to}>
                            <NavLink
                              className="tr-nav"
                              to={item.to}
                              end={item.end ?? true}
                              onClick={() => setOpen(false)}
                            >
                              {item.icon ? (
                                <span className="tr-nav__icon" aria-hidden="true">
                                  {item.icon}
                                </span>
                              ) : null}
                              {item.label}
                              {item.count !== undefined ? (
                                <>
                                  {" "}
                                  <span
                                    className={cx(
                                      "tr-nav__count",
                                      item.critical && item.count > 0 && "tr-nav__count--critical",
                                    )}
                                  >
                                    {formatCount(item.count)}
                                  </span>
                                </>
                              ) : null}
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </nav>
            </div>
          </>
        ) : null}
        <div className="tr-shell__main">
          <main className="tr-shell__content">{children}</main>
          {devBar}
        </div>
      </div>
    </div>
  );
}
