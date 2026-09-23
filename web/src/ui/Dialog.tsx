import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}

// Focus trap, focus return and Escape are Radix's; a hand-rolled modal
// gets one of the three wrong (ADR-0015). Controlled only: the caller owns
// the open state so a form can refuse to close on a pending write.
export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content className="dialog-content">
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
