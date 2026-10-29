import { useRef, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import { ChevronLeftIcon } from "./icons/ChevronLeft";
import { useScrollPadding } from "./useScrollPadding";
import "./DriverShell.css";

export interface DriverShellProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  // The tenant's mark on the app bar, where the back button goes instead.
  brand?: ReactNode;
  // The vehicle while capturing, the organisation otherwise.
  barTitle?: ReactNode;
  barSubtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  // Who the app thinks is asking, as one string, so it reads as one line.
  actor?: string;
  signOut?: ReactNode;
  // Right of the app bar, before sign-out.
  sync?: ReactNode;
  // The outbox (ADR-0009): under the bar, ahead of everything a screen draws.
  status?: ReactNode;
  signIn?: ReactNode;
  // TYRE-242: after the content, never in the bar.
  devBar?: ReactNode;
  eyebrow?: ReactNode;
  title?: ReactNode;
  lede?: ReactNode;
  // The thumb-zone action bar: the screen's one primary button, last in
  // the page so it is the last tab stop.
  footer?: ReactNode;
  children?: ReactNode;
}

export function DriverShell({
  brand,
  barTitle,
  barSubtitle,
  onBack,
  backLabel = "Back",
  actor,
  signOut,
  sync,
  status,
  signIn,
  devBar,
  eyebrow,
  title,
  lede,
  footer,
  className,
  children,
  ...rest
}: DriverShellProps) {
  const bar = useRef<HTMLElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  useScrollPadding(bar, "top");
  useScrollPadding(foot, "bottom", Boolean(footer));
  return (
    <div className={cx("tr-driver", className)} {...rest}>
      <header ref={bar} className="tr-driver__bar">
        {onBack ? (
          <button type="button" className="tr-driver__back" aria-label={backLabel} onClick={onBack}>
            <Icon icon={ChevronLeftIcon} size={24} />
          </button>
        ) : (
          brand
        )}
        <div className="tr-driver__bar-title">
          {barTitle ? <span className="tr-driver__bar-name">{barTitle}</span> : null}
          {barSubtitle ? <span className="tr-driver__bar-sub">{barSubtitle}</span> : null}
          {actor ? <p className="tr-driver__actor">{actor}</p> : null}
        </div>
        {sync}
        {signOut}
      </header>
      {status}
      {signIn}
      <main className="tr-driver__main">
        {title ? (
          <div className="tr-driver__head">
            {eyebrow ? <span className="tr-driver__eyebrow">{eyebrow}</span> : null}
            <h1 className="tr-driver__title">{title}</h1>
            {lede ? <p className="tr-driver__lede">{lede}</p> : null}
          </div>
        ) : null}
        <div className="tr-driver__body">{children}</div>
      </main>
      {devBar}
      {footer ? (
        <div ref={foot} className="tr-driver__foot">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
