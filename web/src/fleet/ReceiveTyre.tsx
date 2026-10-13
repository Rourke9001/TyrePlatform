import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { fetchTyreCatalogue, type TyreCatalogue, type TyrePattern } from "../api/catalogue";
import { getDevTenantId } from "../api/devTenant";
import { refusalMessage } from "../api/refusal";
import {
  COST_SOURCES,
  receiveTyres,
  type CostSource,
  type NewTyres,
  type ReceivedTyre,
} from "../api/tyres";
import { useActor } from "../auth/actorContext";
import { byNaturalCode } from "./unit/naturalOrder";
import { tyreCatalogueKey } from "./unit/queryKeys";
import "./fleet.css";

// app.receive_tyres answers TY011 for its display-code policy, quantity,
// catalogue, tread and cost-source refusals (000053), and display_code_taken
// is its conflict; the lifecycle's other codes belong to endpoints this
// screen never calls.
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
  const [price, setPrice] = useState("");
  // TYRE-370: empty until someone picks one. A recorded cost is never
  // corrected (D5), so a source nobody chose is never sent.
  const [costSource, setCostSource] = useState<CostSource | "">("");
  const [received, setReceived] = useState<ReceivedTyre[] | null>(null);

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
      setPrice("");
      setCostSource("");
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

  const priceEntered = price.trim() !== "";
  const treadEntered = newTread.trim() !== "";
  const treadShaped = TREAD_SHAPE.test(newTread.trim());
  const treadMisshapen = treadEntered && !treadShaped;
  const sourceMissing = priceEntered && costSource === "";

  function brandOf(id: string): string | null {
    return loaded?.patterns.find((p) => p.id === id)?.brandId ?? null;
  }

  // NFR-USE-006: a branded pattern names its brand, so it is not asked twice.
  // A brand filled in that way leaves with its pattern, so no tyre is stored
  // with a brand nobody chose (TYRE-318).
  function choosePattern(id: string) {
    setPatternId(id);
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
    const brand = brandOf(patternId);
    if (brand !== null && brand !== id) setPatternId("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    if (isFree && displayCode.trim() === "") return;
    if (!isFree && quantity.trim() === "") return;
    if (sizeId === "" || patternId === "" || !treadShaped || sourceMissing) return;
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
    if (priceEntered && costSource !== "") {
      body.purchasePrice = price;
      body.costSource = costSource;
    }
    receive.mutate(body);
  }

  return (
    <section aria-labelledby="receive-tyre-heading" className="tyres-receive">
      <h1 className="page-title" id="receive-tyre-heading">
        Receive tyres
      </h1>

      <form onSubmit={submit}>
        {isFree ? (
          <>
            <label htmlFor="displayCode">Display code</label>
            <input
              id="displayCode"
              value={displayCode}
              onChange={(e) => setDisplayCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </>
        ) : (
          <>
            {/* AS-014: under a generated scheme nobody types a code, so the
                one thing this screen must say out loud is the workshop step
                that follows saving. Otherwise a minted code sits unread on
                screen and the sidewall never gets marked. */}
            <p className="tyres-receive-hint">
              The platform assigns the next code. Mark the sidewall with the code shown after
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

        {catalogue.isPending && <p className="tyres-receive-hint">Loading the tyre catalogue…</p>}
        {catalogue.isError && catalogue.data === undefined && (
          <div className="note-card" role="alert">
            <p>The tyre catalogue could not be loaded. Check your connection, then retry.</p>
            <button className="btn-primary" type="button" onClick={() => void catalogue.refetch()}>
              Retry
            </button>
          </div>
        )}
        {loaded !== null && !ready && (
          // TYRE-369 provisions a catalogue and TYRE-417 adds to it; until
          // then a receive here could only be refused.
          <p className="note-card">
            This fleet has no tyre catalogue yet. Ask an administrator to add its tyre sizes and
            new-tyre patterns.
          </p>
        )}
        {ready && (
          <>
            <label htmlFor="sizeId">Size</label>
            <select id="sizeId" value={sizeId} onChange={(e) => setSizeId(e.target.value)} required>
              <option value="">Choose a size</option>
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <label htmlFor="brandId">Brand</label>
            <select id="brandId" value={brandId} onChange={(e) => chooseBrand(e.target.value)}>
              <option value="">No brand chosen</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>

            <label htmlFor="patternId">Pattern</label>
            <select
              id="patternId"
              value={patternId}
              onChange={(e) => choosePattern(e.target.value)}
              required
            >
              <option value="">Choose a pattern</option>
              {patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}

        <label htmlFor="newTreadMm">New tread (mm)</label>
        <input
          id="newTreadMm"
          inputMode="decimal"
          autoComplete="off"
          value={newTread}
          onChange={(e) => setNewTread(e.target.value)}
          required
          aria-invalid={treadMisshapen}
          aria-describedby={treadMisshapen ? "newTreadMm-shape" : undefined}
        />
        {treadMisshapen && (
          <p className="tyres-receive-hint" id="newTreadMm-shape">
            Enter the depth in millimetres, for example 25.0. Use at most three digits and one
            decimal place.
          </p>
        )}

        <label htmlFor="purchasePrice">Purchase price</label>
        <input
          id="purchasePrice"
          inputMode="decimal"
          autoComplete="off"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />

        {priceEntered ? (
          <>
            <label htmlFor="costSource">Cost source</label>
            <select
              id="costSource"
              value={costSource}
              onChange={(e) =>
                setCostSource(COST_SOURCES.find((c) => c.value === e.target.value)?.value ?? "")
              }
              required
              aria-describedby={sourceMissing ? "costSource-why" : undefined}
            >
              <option value="">Choose a source</option>
              {COST_SOURCES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {sourceMissing && (
              <p className="tyres-receive-hint" id="costSource-why">
                Choose where this price came from. A cost cannot be corrected once it is recorded.
              </p>
            )}
          </>
        ) : (
          // CFL-002: an unpriced receive is not an error, it is the normal
          // shape of most intake. Most of what a tenant eventually knows
          // about a tyre is not known yet at the workshop door.
          <p className="tyres-receive-hint">
            Leave the price blank to add this tyre to the awaiting-cost queue.
          </p>
        )}

        <button className="btn-primary" type="submit" disabled={receive.isPending || !ready}>
          {receive.isPending ? "Receiving…" : "Receive"}
        </button>
      </form>

      {receive.isError && <p role="alert">{refusalMessage(receive.error, RECEIVE_WORDING)}</p>}

      {received && (
        // NFR-USE-010: success is shown explicitly, never inferred from the
        // absence of an error. Every code minted here is one the
        // operator still has to go mark a sidewall with.
        <div role="status" className="tyres-receive-success note-card">
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
