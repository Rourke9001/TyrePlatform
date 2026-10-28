import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { moneyText, useCurrency } from "../../api/money";
import {
  applyReceiptListPrice,
  fetchOpenReceipts,
  keepReceiptEstimate,
  type MoveResult,
  type OpenReceipt,
} from "../../api/receipts";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Dialog } from "../../ui/Dialog";
import { IconButton } from "../../ui/IconButton";
import { CloseIcon } from "../../ui/icons/Close";
import { PageHeader } from "../../ui/PageHeader";
import { receiptStateLabel } from "../../domain/vocabulary";
import { RefusalAlert } from "../RefusalAlert";
import { openReceiptsKey, tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";
import { InvoiceForm } from "./InvoiceForm";
import { moveMessage, RECEIPT_WORDING } from "./receiptWords";
import "../fleet.css";

// One open receipt and the moves its state allows (000059): an invoice from
// either, the list price on an unpriced one, and keeping the estimate on an
// estimated one, which is final and so asks first.
function ReceiptRow({
  receipt,
  tenantKey,
  canSeeMoney,
  onMoved,
}: {
  receipt: OpenReceipt;
  tenantKey: string;
  canSeeMoney: boolean;
  onMoved: (message: string) => void;
}) {
  const asDate = useTenantDate();
  const currency = useCurrency();
  const [invoicing, setInvoicing] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const invalidate = [openReceiptsKey(tenantKey), tyresKey(tenantKey)];
  const estimated = receipt.priceState === "ESTIMATED";

  const listPrice = useFormMutation<void, MoveResult>({
    mutate: () => applyReceiptListPrice(receipt.id),
    invalidate,
    onSuccess: (result) => onMoved(moveMessage("list-price", result)),
  });
  const keep = useFormMutation<void, void>({
    mutate: () => keepReceiptEstimate(receipt.id),
    invalidate,
    onSuccess: () => {
      setKeeping(false);
      onMoved("Estimate kept. This receipt's price is final.");
    },
  });

  // Escape, the backdrop, Cancel and Close all leave it open while the write is pending.
  const closeKeeping = () => {
    if (!keep.isPending) setKeeping(false);
  };

  const codes = receipt.displayCodes.join(", ");
  const quantity =
    receipt.inFleet === receipt.quantity
      ? String(receipt.quantity)
      : `${String(receipt.quantity)}, ${String(receipt.inFleet)} in the fleet`;
  return (
    <tr>
      <td data-nowrap="true">{asDate(receipt.receivedDate)}</td>
      <td>{receipt.depotName ?? "Not recorded"}</td>
      <td data-mono="true">{receipt.sizeName}</td>
      <td>{receipt.brandName ?? "No brand"}</td>
      <td>{receipt.patternName}</td>
      <td>{quantity}</td>
      <th scope="row" data-mono="true">
        {codes}
      </th>
      <td data-align="right" data-mono="true">
        {moneyText(receipt.unitPrice ?? null, canSeeMoney, currency)}
      </td>
      <td>{receiptStateLabel(receipt.priceState)}</td>
      <td>
        <div className="fleet-row-form">
          <Button aria-expanded={invoicing} onClick={() => setInvoicing((open) => !open)}>
            Record invoice
          </Button>
          {receipt.priceState === "UNPRICED" && (
            <Button disabled={listPrice.isPending} onClick={() => listPrice.submit(undefined)}>
              Apply list price
            </Button>
          )}
          {estimated && <Button onClick={() => setKeeping(true)}>Keep the estimate</Button>}
        </div>
        {invoicing && (
          <InvoiceForm
            receipt={receipt}
            tenantKey={tenantKey}
            onRecorded={(result) => onMoved(moveMessage("invoice", result))}
          />
        )}
        <RefusalAlert error={listPrice.error} wording={RECEIPT_WORDING} />
        <Dialog
          open={keeping}
          onClose={closeKeeping}
          dismissOnBackdrop
          title="Keep the estimate as final?"
          description="No invoice can be recorded for this receipt afterwards."
          actions={
            <>
              <Button
                variant="primary"
                disabled={keep.isPending}
                onClick={() => keep.submit(undefined)}
              >
                Keep the estimate
              </Button>
              <Button variant="ghost" disabled={keep.isPending} onClick={() => setKeeping(false)}>
                Cancel
              </Button>
              <IconButton label="Close" icon={CloseIcon} onClick={closeKeeping} />
            </>
          }
        >
          {keep.error !== null && <RefusalAlert error={keep.error} wording={RECEIPT_WORDING} />}
        </Dialog>
      </td>
    </tr>
  );
}

// FR-CFG-041: the receipts still waiting for their price, priced a whole
// set at a time. Gated as Receive tyres is (ManageAssets, routes.tsx).
export function ReceiptList() {
  const tenantKey = getDevTenantId() ?? "default";
  const canSeeMoney = useCan("ViewValuation");
  // Held here, not in the row: a moved receipt leaves the list on the
  // refetch, and a confirmation inside it would leave with it (NFR-USE-010).
  const [moved, setMoved] = useState<string | null>(null);
  const receipts = useQuery({ queryKey: openReceiptsKey(tenantKey), queryFn: fetchOpenReceipts });

  return (
    <section aria-labelledby="receipts-heading" className="fleet-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader
        title={<span id="receipts-heading">Receipts</span>}
        back={{ label: "Back to register", to: "/fleet/tyres" }}
      />

      {moved !== null && <p role="status">{moved}</p>}

      {receipts.isPending && <p>Loading…</p>}

      {receipts.isError && (
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Receipts didn&apos;t load</h2>}
          action={<Button onClick={() => void receipts.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {receipts.isSuccess && receipts.data.length === 0 && (
        <p className="fleet-note">No receipts are waiting for their price.</p>
      )}

      {receipts.isSuccess && receipts.data.length > 0 && (
        <Card padding="none">
          <div className="fleet-table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th scope="col">Received</th>
                  <th scope="col">Depot</th>
                  <th scope="col">Size</th>
                  <th scope="col">Brand</th>
                  <th scope="col">Pattern</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Codes</th>
                  <th scope="col" data-align="right">
                    Unit price
                  </th>
                  <th scope="col">State</th>
                  <th scope="col">Price it</th>
                </tr>
              </thead>
              <tbody>
                {receipts.data.map((r) => (
                  <ReceiptRow
                    key={r.id}
                    receipt={r}
                    tenantKey={tenantKey}
                    canSeeMoney={canSeeMoney}
                    onMoved={setMoved}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}
