import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

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
import { Dialog } from "../../ui/Dialog";
import { receiptStateLabel } from "../../ui/vocabulary";
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
    onSuccess: (result) => onMoved(moveMessage("list-price", result, false)),
  });
  const keep = useFormMutation<void, void>({
    mutate: () => keepReceiptEstimate(receipt.id),
    invalidate,
    onSuccess: () => {
      setKeeping(false);
      onMoved("Estimate kept. This receipt's price is final.");
    },
  });

  const codes = receipt.displayCodes.join(", ");
  const quantity =
    receipt.inFleet === receipt.quantity
      ? String(receipt.quantity)
      : `${String(receipt.quantity)}, ${String(receipt.inFleet)} in the fleet`;
  return (
    <tr>
      <td>{asDate(receipt.receivedDate)}</td>
      <td>{receipt.depotName ?? "Not recorded"}</td>
      <td>{receipt.sizeName}</td>
      <td>{receipt.brandName ?? "No brand"}</td>
      <td>{receipt.patternName}</td>
      <td>{quantity}</td>
      <th scope="row">{codes}</th>
      <td>{moneyText(receipt.unitPrice ?? null, canSeeMoney, currency)}</td>
      <td>{receiptStateLabel(receipt.priceState)}</td>
      <td>
        <div className="tyres-row-form">
          <button
            className="btn-primary btn-compact"
            type="button"
            aria-expanded={invoicing}
            onClick={() => setInvoicing((open) => !open)}
          >
            Record invoice
          </button>
          {receipt.priceState === "UNPRICED" && (
            <button
              className="btn-primary btn-compact"
              type="button"
              disabled={listPrice.isPending}
              onClick={() => listPrice.submit(undefined)}
            >
              Apply list price
            </button>
          )}
          {estimated && (
            <button
              className="btn-primary btn-compact"
              type="button"
              onClick={() => setKeeping(true)}
            >
              Keep the estimate
            </button>
          )}
        </div>
        {invoicing && (
          <InvoiceForm
            receipt={receipt}
            tenantKey={tenantKey}
            onRecorded={(result) => onMoved(moveMessage("invoice", result, estimated))}
          />
        )}
        <RefusalAlert error={listPrice.error} wording={RECEIPT_WORDING} />
        <Dialog
          open={keeping}
          onOpenChange={(open) => {
            if (!keep.isPending) setKeeping(open);
          }}
          title="Keep the estimate as final?"
          description="No invoice can be recorded for this receipt afterwards."
        >
          <div className="tyres-row-form">
            <button
              className="btn-primary"
              type="button"
              disabled={keep.isPending}
              onClick={() => keep.submit(undefined)}
            >
              Keep the estimate
            </button>
            <button
              className="btn btn-quiet"
              type="button"
              disabled={keep.isPending}
              onClick={() => setKeeping(false)}
            >
              Cancel
            </button>
          </div>
          <RefusalAlert error={keep.error} wording={RECEIPT_WORDING} />
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
    <section aria-labelledby="receipts-heading" className="receipts">
      <div className="tyres-heading-row">
        <h1 className="page-title" id="receipts-heading">
          Receipts
        </h1>
        <Link to="/fleet/tyres">Back to register</Link>
      </div>

      {moved !== null && <p role="status">{moved}</p>}

      {receipts.isPending && <p>Loading…</p>}

      {receipts.isError && (
        <div className="note-card" role="alert">
          <h2>Receipts didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void receipts.refetch()}>
            Retry
          </button>
        </div>
      )}

      {receipts.isSuccess && receipts.data.length === 0 && (
        <p className="note-card">No receipts are waiting for their price.</p>
      )}

      {receipts.isSuccess && receipts.data.length > 0 && (
        <table className="tyres-table">
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Depot</th>
              <th scope="col">Size</th>
              <th scope="col">Brand</th>
              <th scope="col">Pattern</th>
              <th scope="col">Quantity</th>
              <th scope="col">Codes</th>
              <th scope="col">Unit price</th>
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
      )}
    </section>
  );
}
