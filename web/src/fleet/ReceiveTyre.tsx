import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { fetchTyreCatalogue, type TyreCatalogue, type TyrePattern } from "../api/catalogue";
import { getDevTenantId } from "../api/devTenant";
import { formatMoney, useCurrency } from "../api/money";
import { fetchPriceEstimate } from "../api/receipts";
import { refusalMessage } from "../api/refusal";
import { receiveTyres, type NewTyres, type ReceivedTyre } from "../api/tyres";
import { useActor } from "../auth/actorContext";
import { useTenantDate } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { TextInput } from "../ui/TextInput";
import { byNaturalCode } from "./unit/naturalOrder";
import { priceEstimateKey, tyreCatalogueKey } from "./unit/queryKeys";
import "./fleet.css";

// app.receive_tyres answers TY011 for its display-code policy, quantity,
// catalogue, tread and cost-source refusals (000053), a received date after
// the tenant's today (TYRE-418), an invoice number without an invoice price,
// and an estimate off the price list or with no list entry in force
// (000059); display_code_taken is its conflict. The lifecycle's other codes
// belong to endpoints this screen never calls.
const RECEIVE_WORDING = {
  speakable: ["display_code_taken", "TY011"],
  forbidden: "You do not have permission to receive tyres.",
  fallback: "The tyres could not be received. Try again, or call support if it keeps happening.",
};

// The shape numeric(4,1) holds (DR-007), so a four-digit entry is named here
// rather than coming back as 22003's generic refusal. A convenience only:
// app.receive_tyres' cast and its ceiling (TYRE-128 decision 8) decide.
const TREAD_SHAPE = /^\d{1,3}(\.\d)?$/;

// FR-CFG-004: a received tyre is new, so a retread-only pattern is never
// offered. A chosen brand narrows to its own patterns and the unbranded.
function newTyrePatterns(catalogue: TyreCatalogue, brandId: string): TyrePattern[] {
  return catalogue.patterns
    .filter((p) => p.appliesTo !== "RETREAD")
    .filter((p) => brandId === "" || p.brandId === null || p.brandId === brandId)
    .sort((a, b) => byNaturalCode(a.name, b.name));
}

// FR-TYR-040, gated on ManageAssets, policy-aware (D12): under GENERATED a
// hand-typed code is refused server-side (TY011), so the field is never
// offered at all; under FREE the code is the one thing the form must collect.
export function ReceiveTyre() {
  const actor = useActor();
  // A policy value this client has not heard of yet defaults to the safer
  // branch: GENERATED's fields never block a submission, where FREE's
  // required code would (me.ts's own comment on why this stays a plain
  // string rather than a union).
  const isFree = actor?.displayCodePolicy === "FREE";
  const tenantKey = getDevTenantId() ?? "default";

  const catalogue = useQuery({
    queryKey: tyreCatalogueKey(tenantKey),
    queryFn: fetchTyreCatalogue,
  });

  const [quantity, setQuantity] = useState("1");
  const [displayCode, setDisplayCode] = useState("");
  const [sizeId, setSizeId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [brandFromPattern, setBrandFromPattern] = useState(false);
  const [patternId, setPatternId] = useState("");
  const [newTread, setNewTread] = useState("");
  // FR-CFG-041: null follows the price list; anything typed, even the list's
  // own figure, is an invoice price, since the person took it from
  // somewhere other than the list. A new size, pattern or brand sets it
  // back to null: what was typed priced the tyres chosen before.
  const [typed, setTyped] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  // TYRE-418: both optional. A blank received date is the tenant's today,
  // decided by the server, so no browser clock reaches a tenant-day
  // comparison (rule 6).
  const [purchaseDate, setPurchaseDate] = useState("");
  const [receivedDate, setReceivedDate] = useState("");
  const [received, setReceived] = useState<ReceivedTyre[] | null>(null);
  const currency = useCurrency();
  const asDate = useTenantDate();
  const queryClient = useQueryClient();

  // Read once size and pattern are chosen, with the brand and date the
  // receive will send: a receive always names a pattern, and a branded one
  // supplies the brand the match uses (spec, The brand the match uses).
  const estimateKey = priceEstimateKey(tenantKey, sizeId, patternId, brandId, receivedDate);
  const estimateWanted = sizeId !== "" && patternId !== "";
  const estimate = useQuery({
    queryKey: estimateKey,
    queryFn: () =>
      fetchPriceEstimate({
        sizeId,
        patternId,
        brandId: brandId === "" ? undefined : brandId,
        receivedDate: receivedDate === "" ? undefined : receivedDate,
      }),
    enabled: estimateWanted,
  });

  const receive = useMutation({
    mutationFn: receiveTyres,
    onSuccess: (tyres) => {
      setReceived(tyres);
      setQuantity("1");
      setDisplayCode("");
      setSizeId("");
      setBrandId("");
      setBrandFromPattern(false);
      setPatternId("");
      setNewTread("");
      setTyped(null);
      setInvoiceNumber("");
      setPurchaseDate("");
      setReceivedDate("");
    },
    // A refusal may be the list moving under the form (the estimate is no
    // longer the list's figure), so the estimate is read again and an
    // untyped price follows it.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: estimateKey });
    },
  });

  // The data, not isSuccess: a failed background refetch keeps the last
  // catalogue, and the pickers must not vanish mid-entry.
  const loaded = catalogue.data ?? null;
  // NFR-USE-012: the server orders by length then name, which is natural
  // only among codes of one shape, so each list is sorted by name here.
  const sizes = loaded ? [...loaded.sizes].sort((a, b) => byNaturalCode(a.name, b.name)) : [];
  const brands = loaded ? [...loaded.brands].sort((a, b) => byNaturalCode(a.name, b.name)) : [];
  const patterns = loaded ? newTyrePatterns(loaded, brandId) : [];
  const ready = loaded !== null && sizes.length > 0 && newTyrePatterns(loaded, "").length > 0;

  const treadEntered = newTread.trim() !== "";
  const treadShaped = TREAD_SHAPE.test(newTread.trim());
  const treadMisshapen = treadEntered && !treadShaped;

  const listed = estimateWanted ? (estimate.data ?? null) : null;
  const estimateReading = estimateWanted && estimate.isFetching;
  const estimateFailed = estimateWanted && estimate.isError && !estimate.isFetching;
  const shownPrice = typed ?? listed?.typicalPrice ?? "";
  const invoicePrice = typed !== null && typed.trim() !== "";
  const listPrice = typed === null && listed !== null;
  // Decision 22: a failed read is never read as "no list entry", so the
  // receive waits until the read succeeds or the person types a price.
  const priceUnsettled = estimateReading || (estimateFailed && !invoicePrice);

  function brandOf(id: string): string | null {
    return loaded?.patterns.find((p) => p.id === id)?.brandId ?? null;
  }

  function chooseSize(id: string) {
    setSizeId(id);
    setTyped(null);
  }

  // NFR-USE-006: a branded pattern names its brand, so it is not asked twice.
  // A brand filled in that way leaves with its pattern, so no tyre is stored
  // with a brand nobody chose (TYRE-318).
  function choosePattern(id: string) {
    setPatternId(id);
    setTyped(null);
    const brand = brandOf(id);
    if (brand !== null) {
      if (brand !== brandId) {
        setBrandId(brand);
        setBrandFromPattern(true);
      }
    } else if (brandFromPattern) {
      setBrandId("");
      setBrandFromPattern(false);
    }
  }

  // A branded pattern the new choice does not own is cleared, so the form
  // never shows one brand while app.receive_tyres stores another.
  function chooseBrand(id: string) {
    setBrandId(id);
    setBrandFromPattern(false);
    setTyped(null);
    const brand = brandOf(patternId);
    if (brand !== null && brand !== id) setPatternId("");
  }

  // What the price is and where it came from, in one line beside it.
  function priceHint(): string {
    if (invoicePrice) {
      return listed === null
        ? "This is an invoice price."
        : `This is an invoice price, not the price list estimate of ${formatMoney(listed.typicalPrice, currency)}.`;
    }
    if (listPrice) {
      const scope = listed.brandSpecific ? "this size and brand" : "this size, any brand";
      return `Price list estimate for ${scope}, effective ${asDate(listed.effectiveFrom)}`;
    }
    // CFL-002: an unpriced receive is not an error, it is the normal shape
    // of most intake. Most of what a tenant eventually knows about a tyre is
    // not known yet at the workshop door.
    return "Leave the price blank to add this tyre to the awaiting-cost queue.";
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    if (isFree && displayCode.trim() === "") return;
    if (!isFree && quantity.trim() === "") return;
    if (sizeId === "" || patternId === "" || !treadShaped || priceUnsettled) return;
    setReceived(null);

    const body: NewTyres = {
      ...(isFree ? { displayCode } : { quantity: Number(quantity) }),
      sizeId,
      patternId,
      newTreadMm: newTread.trim(),
    };
    if (brandId !== "") body.brandId = brandId;
    // Price is the one field that must never round-trip through Number():
    // all money is decimal text end to end (rule 2), and the cent-exact
    // valuation gate is the whole reason a JS float never touches it here.
    // The invoice number goes only with an invoice price, the one place it
    // is shown (Decision 22).
    if (invoicePrice) {
      body.purchasePrice = typed;
      body.costSource = "INVOICE";
      if (invoiceNumber.trim() !== "") body.invoiceNumber = invoiceNumber.trim();
    } else if (listPrice) {
      body.purchasePrice = listed.typicalPrice;
      body.costSource = "PRICE_LIST_ESTIMATE";
    }
    if (purchaseDate !== "") body.purchaseDate = purchaseDate;
    if (receivedDate !== "") body.receivedDate = receivedDate;
    receive.mutate(body);
  }

  return (
    <section aria-labelledby="receive-tyre-heading" className="fleet-form-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader title={<span id="receive-tyre-heading">Receive tyres</span>} />

      <form className="tr-stack" onSubmit={submit}>
        <Card>
          <div className="fleet-fields">
            {isFree ? (
              <Field label="Display code">
                <TextInput
                  id="displayCode"
                  name="displayCode"
                  mono
                  value={displayCode}
                  onChange={(e) => setDisplayCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>
            ) : (
              <>
                {/* AS-014: under a generated scheme nobody types a code, so
                    the one thing this screen must say out loud is the
                    workshop step that follows saving. Otherwise a minted
                    code sits unread on screen and the sidewall never gets
                    marked. */}
                <p className="fleet-hint fleet-fields__wide">
                  The platform assigns the next code. Mark the sidewall with the code shown after
                  saving.
                </p>
                <Field label="Quantity">
                  <TextInput
                    id="quantity"
                    name="quantity"
                    type="number"
                    mono
                    min={1}
                    max={200}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </Field>
              </>
            )}

            {catalogue.isPending && (
              <p className="fleet-hint fleet-fields__wide">Loading the tyre catalogue…</p>
            )}
            {catalogue.isError && catalogue.data === undefined && (
              <Banner
                className="fleet-fields__wide"
                tone="critical"
                title="The tyre catalogue could not be loaded. Check your connection, then retry."
                action={<Button onClick={() => void catalogue.refetch()}>Retry</Button>}
              />
            )}
            {loaded !== null && !ready && (
              // TYRE-369 provisions a catalogue and TYRE-417 adds to it; until
              // then a receive here could only be refused.
              <p className="fleet-callout fleet-fields__wide">
                This fleet has no tyre catalogue yet. Ask an administrator to add its tyre sizes and
                new-tyre patterns.
              </p>
            )}
            {ready && (
              <>
                <Field label="Size">
                  <Select
                    id="sizeId"
                    name="sizeId"
                    value={sizeId}
                    onChange={(e) => chooseSize(e.target.value)}
                    required
                    options={[
                      { value: "", label: "Choose a size" },
                      ...sizes.map((z) => ({ value: z.id, label: z.name })),
                    ]}
                  />
                </Field>

                <Field label="Brand">
                  <Select
                    id="brandId"
                    name="brandId"
                    value={brandId}
                    onChange={(e) => chooseBrand(e.target.value)}
                    options={[
                      { value: "", label: "No brand chosen" },
                      ...brands.map((b) => ({ value: b.id, label: b.name })),
                    ]}
                  />
                </Field>

                <Field label="Pattern">
                  <Select
                    id="patternId"
                    name="patternId"
                    value={patternId}
                    onChange={(e) => choosePattern(e.target.value)}
                    required
                    options={[
                      { value: "", label: "Choose a pattern" },
                      ...patterns.map((pt) => ({ value: pt.id, label: pt.name })),
                    ]}
                  />
                </Field>
              </>
            )}

            <Field
              label="New tread (mm)"
              error={
                treadMisshapen
                  ? "Enter the depth in millimetres, for example 25.0. Use at most three digits and one decimal place."
                  : undefined
              }
            >
              <TextInput
                id="newTreadMm"
                name="newTreadMm"
                mono
                inputMode="decimal"
                autoComplete="off"
                value={newTread}
                onChange={(e) => setNewTread(e.target.value)}
                required
                aria-invalid={treadMisshapen}
              />
            </Field>

            <Field label="Received date (optional, blank is today)">
              <TextInput
                id="receivedDate"
                name="receivedDate"
                type="date"
                autoComplete="off"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <div className="fleet-fields">
            <div className="fleet-field-group">
              <Field label="Unit price">
                <TextInput
                  id="purchasePrice"
                  name="purchasePrice"
                  mono
                  inputMode="decimal"
                  autoComplete="off"
                  value={shownPrice}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-describedby="purchasePrice-source"
                />
              </Field>
              <p className="fleet-hint" id="purchasePrice-source" aria-live="polite">
                {priceHint()}
              </p>
            </div>

            {invoicePrice && (
              <Field label="Invoice number (optional)">
                <TextInput
                  id="invoiceNumber"
                  name="invoiceNumber"
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                />
              </Field>
            )}

            <Field label="Purchase date (optional)">
              <TextInput
                id="purchaseDate"
                name="purchaseDate"
                type="date"
                autoComplete="off"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
              />
            </Field>

            {estimateFailed && (
              <Banner
                className="fleet-fields__wide"
                tone="critical"
                title="The price list could not be read. Retry, or type the invoice price."
                action={<Button onClick={() => void estimate.refetch()}>Retry</Button>}
              />
            )}
          </div>
        </Card>

        <div className="fleet-form-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={receive.isPending || !ready || priceUnsettled}
          >
            {receive.isPending ? "Receiving…" : "Receive"}
          </Button>
        </div>
      </form>

      {receive.isError && (
        <Banner tone="critical" title={refusalMessage(receive.error, RECEIVE_WORDING)} />
      )}

      {received && (
        // NFR-USE-010: success is shown explicitly, never inferred from the
        // absence of an error. Every code minted here is one the
        // operator still has to go mark a sidewall with.
        <Banner
          tone="success"
          title={`${received.length === 1 ? "1 tyre" : `${received.length} tyres`} received.`}
        >
          <ul className="fleet-codes">
            {received.map((t) => (
              <li key={t.id}>{t.displayCode}</li>
            ))}
          </ul>
        </Banner>
      )}
    </section>
  );
}
