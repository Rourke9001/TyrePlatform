import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ApiError } from "../api/client";
import { receiveTyres, type NewTyres, type ReceivedTyre } from "../api/tyres";
import { useActor } from "../auth/actorContext";
import "./fleet.css";

type CostSource = "INVOICE" | "PRICE_LIST_ESTIMATE";

const COST_SOURCES: { value: CostSource; label: string }[] = [
  { value: "INVOICE", label: "Invoice" },
  { value: "PRICE_LIST_ESTIMATE", label: "Price list estimate" },
];

// A refused receive says what happened in the words of whoever knows: the
// tyre lifecycle's own refusals (TY011..TY013, ADR-0012's TY class) and the
// register's own conflict code are safe to render verbatim (ADR-0013);
// anything else gets the general sentence rather than a wrong specific one.
// Shape mirrors AddUnit.tsx:22-33.
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const speakable = [
      "display_code_taken",
      "TY011",
      "TY012",
      "TY013",
      "invalid_submission",
      "conflict",
    ];
    if (speakable.includes(error.code) && error.message !== "") {
      return error.message;
    }
    if (error.code === "forbidden") {
      return "You do not have permission to receive tyres.";
    }
  }
  return "The tyres could not be received. Try again, or call support if it keeps happening.";
}

// FR-TYR-040, gated on ManageAssets (routed in Task 12) and policy-aware
// (D12): under GENERATED a hand-typed code is refused server-side
// (app.receive_tyres's own TY011), so this screen never offers the field at
// all rather than offering it and losing the submission to a refusal the
// operator could not have predicted. Under FREE the platform mints nothing,
// so the code is the one thing this form must collect, and a bulk receive
// makes no sense against one hand-typed code (the function's own rule) —
// quantity is a GENERATED-only control for the same reason.
export function ReceiveTyre() {
  const actor = useActor();
  // A policy value this client has not heard of yet defaults to the safer
  // branch: GENERATED's fields never block a submission, where FREE's
  // required code would (me.ts's own comment on why this stays a plain
  // string rather than a union).
  const isFree = actor?.displayCodePolicy === "FREE";

  const [quantity, setQuantity] = useState("1");
  const [displayCode, setDisplayCode] = useState("");
  const [price, setPrice] = useState("");
  const [costSource, setCostSource] = useState<CostSource>("INVOICE");
  const [received, setReceived] = useState<ReceivedTyre[] | null>(null);

  const receive = useMutation({
    mutationFn: receiveTyres,
    onSuccess: (tyres) => {
      setReceived(tyres);
      setQuantity("1");
      setDisplayCode("");
      setPrice("");
      setCostSource("INVOICE");
    },
  });

  const priceEntered = price.trim() !== "";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (isFree && displayCode.trim() === "") return;
    if (!isFree && quantity.trim() === "") return;
    setReceived(null);

    const body: NewTyres = isFree ? { displayCode } : { quantity: Number(quantity) };
    // Price is the one field that must never round-trip through Number():
    // all money is decimal text end to end (rule 2), and the cent-exact
    // valuation gate is the whole reason a JS float never touches it here.
    if (priceEntered) {
      body.purchasePrice = price;
      body.costSource = costSource;
    }
    receive.mutate(body);
  }

  return (
    <section aria-labelledby="receive-tyre-heading" className="tyres-receive">
      <h1 id="receive-tyre-heading">Receive tyres</h1>

      <form onSubmit={submit}>
        {isFree ? (
          <>
            <label htmlFor="displayCode">Display code</label>
            <input
              id="displayCode"
              value={displayCode}
              onChange={(e) => setDisplayCode(e.target.value)}
              required
            />
          </>
        ) : (
          <>
            {/* AS-014: under a generated scheme nobody types a code, so the
                one thing this screen must say out loud is the workshop step
                that follows saving — otherwise a minted code sits unread on
                screen and the sidewall never gets marked. */}
            <p className="tyres-receive-hint">
              The platform assigns the next code — mark the sidewall with the code shown after
              saving.
            </p>
            <label htmlFor="quantity">Quantity</label>
            <input
              id="quantity"
              type="number"
              min={1}
              max={200}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </>
        )}

        <label htmlFor="purchasePrice">Purchase price</label>
        <input
          id="purchasePrice"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />

        {priceEntered ? (
          <>
            <label htmlFor="costSource">Cost source</label>
            <select
              id="costSource"
              value={costSource}
              onChange={(e) => setCostSource(e.target.value as CostSource)}
            >
              {COST_SOURCES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          // CFL-002: an unpriced receive is not an error, it is the normal
          // shape of most intake — most of what a tenant eventually knows
          // about a tyre is not known yet at the workshop door.
          <p className="tyres-receive-hint">
            Leave the price blank to add this tyre to the awaiting-cost queue.
          </p>
        )}

        <button type="submit" disabled={receive.isPending}>
          {receive.isPending ? "Receiving…" : "Receive"}
        </button>
      </form>

      {receive.isError && <p role="alert">{refusalMessage(receive.error)}</p>}

      {received && (
        // NFR-USE-010: success is shown explicitly, never inferred from the
        // absence of an error — and every code minted here is one the
        // operator still has to go mark a sidewall with.
        <div role="status" className="tyres-receive-success">
          <p>{received.length === 1 ? "1 tyre" : `${received.length} tyres`} received.</p>
          <ul>
            {received.map((t) => (
              <li key={t.id}>{t.displayCode}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
