import { useState, type FormEvent } from "react";

import { recordReceiptInvoice, type MoveResult, type OpenReceipt } from "../../api/receipts";
import { RefusalAlert } from "../RefusalAlert";
import { openReceiptsKey, tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";
import { RECEIPT_WORDING } from "./receiptWords";

interface InvoiceBody {
  price: string;
  invoiceNumber?: string;
  invoiceDate?: string;
}

// FR-CFG-041, spec D2 and D3: one invoice prices every tyre on the receipt
// still in the fleet, once. The number and date are optional; the date is
// the tyres' purchase date, and the server refuses one after today.
export function InvoiceForm({
  receipt,
  tenantKey,
  onRecorded,
}: {
  receipt: OpenReceipt;
  tenantKey: string;
  onRecorded: (result: MoveResult) => void;
}) {
  const [price, setPrice] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [refused, setRefused] = useState("");

  const record = useFormMutation<InvoiceBody, MoveResult>({
    mutate: (body) => recordReceiptInvoice(receipt.id, body),
    invalidate: [openReceiptsKey(tenantKey), tyresKey(tenantKey)],
    onSuccess: onRecorded,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (price.trim() === "") {
      setRefused("Enter the unit price from the invoice.");
      return;
    }
    setRefused("");
    // Money stays the typed string (rule 2); the database rounds it.
    const body: InvoiceBody = { price: price.trim() };
    if (invoiceNumber.trim() !== "") body.invoiceNumber = invoiceNumber.trim();
    if (invoiceDate !== "") body.invoiceDate = invoiceDate;
    record.submit(body);
  }

  const id = (field: string) => `${field}-${receipt.id}`;
  return (
    <form onSubmit={submit} className="tyres-row-form">
      <label htmlFor={id("invoicePrice")}>Unit price</label>
      <input
        id={id("invoicePrice")}
        name="price"
        inputMode="decimal"
        autoComplete="off"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        required
      />
      <label htmlFor={id("invoiceNumber")}>Invoice number (optional)</label>
      <input
        id={id("invoiceNumber")}
        name="invoiceNumber"
        autoComplete="off"
        spellCheck={false}
        value={invoiceNumber}
        onChange={(e) => setInvoiceNumber(e.target.value)}
      />
      <label htmlFor={id("invoiceDate")}>Invoice date (optional)</label>
      <input
        id={id("invoiceDate")}
        name="invoiceDate"
        type="date"
        autoComplete="off"
        value={invoiceDate}
        onChange={(e) => setInvoiceDate(e.target.value)}
      />
      <button className="btn-primary btn-compact" type="submit" disabled={record.isPending}>
        {record.isPending ? "Saving…" : "Save invoice"}
      </button>
      <RefusalAlert message={refused} />
      <RefusalAlert error={record.error} wording={RECEIPT_WORDING} />
    </form>
  );
}
