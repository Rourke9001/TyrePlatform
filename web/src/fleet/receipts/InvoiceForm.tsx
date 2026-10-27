import { useState, type FormEvent } from "react";

import { recordReceiptInvoice, type MoveResult, type OpenReceipt } from "../../api/receipts";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { TextInput } from "../../ui/TextInput";
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
    <form onSubmit={submit} className="fleet-row-form fleet-invoice">
      <Field label="Unit price">
        <TextInput
          id={id("invoicePrice")}
          name="price"
          mono
          inputMode="decimal"
          autoComplete="off"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
        />
      </Field>
      <Field label="Invoice number (optional)">
        <TextInput
          id={id("invoiceNumber")}
          name="invoiceNumber"
          mono
          autoComplete="off"
          spellCheck={false}
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
        />
      </Field>
      <Field label="Invoice date (optional)">
        <TextInput
          id={id("invoiceDate")}
          name="invoiceDate"
          type="date"
          autoComplete="off"
          value={invoiceDate}
          onChange={(e) => setInvoiceDate(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={record.isPending}>
        {record.isPending ? "Saving…" : "Save invoice"}
      </Button>
      <RefusalAlert message={refused} />
      <RefusalAlert error={record.error} wording={RECEIPT_WORDING} />
    </form>
  );
}
