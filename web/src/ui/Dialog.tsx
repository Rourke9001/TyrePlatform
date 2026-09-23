import * as RadixDialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}

// Focus trap and Escape are Radix's; a hand-rolled modal gets one of them
// wrong (ADR-0015). Controlled only: the caller owns the open state so a
// form can refuse to close on a pending write.
export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  // Radix returns focus to its own Trigger, which a dialog opened by the
  // caller's button does not have, so without this focus lands on the body
  // on close. The opener is kept here instead (WCAG 2.4.3).
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content
          className="dialog-content"
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="dialog-description">
              {description}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="visually-hidden">{title}</RadixDialog.Description>
          )}
          {children}
          <RadixDialog.Close className="btn btn-quiet dialog-close" aria-label="Close">
            x
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
