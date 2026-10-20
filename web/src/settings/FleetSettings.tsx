import { useQuery } from "@tanstack/react-query";

import type { TyreCatalogue } from "../api/catalogue";
import { getDevTenantId } from "../api/devTenant";
import { currencyName, moneyText } from "../api/money";
import { fetchFleetSettings, type ConsentCurrent, type FleetSettingsBody } from "../api/settings";
import { fleetSettingsKey } from "../fleet/unit/queryKeys";
import { useTenantDate } from "../time/tenantTime";
import { unitLabels } from "../units/units";
import {
  CONSENT_PURPOSES,
  consentPurposeLabel,
  consentStateLabel,
  formatMm,
  lineageLabel,
  thresholdScopeLabel,
} from "../ui/vocabulary";
import "../fleet/fleet.css";

// Every known purpose in the vocabulary's order, then any purpose the
// server recorded that this client does not know, under its code, so a
// recorded consent is never hidden (OR-LEG-005).
function consentRows(
  recorded: ConsentCurrent[],
): { purpose: string; row: ConsentCurrent | null }[] {
  const byPurpose = new Map(recorded.map((c) => [c.purpose, c]));
  const unknown = recorded.map((c) => c.purpose).filter((p) => !CONSENT_PURPOSES.includes(p));
  return [...CONSENT_PURPOSES, ...unknown].map((purpose) => ({
    purpose,
    row: byPurpose.get(purpose) ?? null,
  }));
}

function Fleet({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  const units = unitLabels(body.fleet.pressureUnit, body.fleet.distanceUnit);
  return (
    <section aria-labelledby="settings-fleet" className="note-card">
      <h2 id="settings-fleet">Fleet</h2>
      <dl>
        <dt>Timezone</dt>
        <dd>{body.fleet.timezone}</dd>
        <dt>Currency</dt>
        <dd>{currencyName(body.fleet.currency)}</dd>
        <dt>Pressure</dt>
        <dd>{units.pressure}</dd>
        <dt>Distance</dt>
        <dd>{units.distance}</dd>
        <dt>History</dt>
        <dd>
          {body.fleet.historyHorizon === null
            ? "No imported history"
            : `Live capture from ${asDate(body.fleet.historyHorizon)}`}
        </dd>
      </dl>
    </section>
  );
}

// FR-CFG-012 as revised by TYRE-299: the thresholds that exist. There is
// no scrap threshold (U68).
function Thresholds({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  return (
    <section aria-labelledby="settings-thresholds">
      <h2 id="settings-thresholds">Tread thresholds</h2>
      {body.thresholds.length === 0 ? (
        <p className="note-card">No tread thresholds are in force.</p>
      ) : (
        <table className="tyres-table">
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col">Removal threshold</th>
              <th scope="col">Warning threshold</th>
              <th scope="col">Retreads</th>
              <th scope="col">In force since</th>
            </tr>
          </thead>
          <tbody>
            {body.thresholds.map((t) => {
              const scope = thresholdScopeLabel(t.operatingGroupName, t.axleClass);
              return (
                <tr key={scope}>
                  <th scope="row">{scope}</th>
                  <td>{formatMm(t.removalThresholdMm)}</td>
                  <td>
                    {t.warningThresholdMm === null ? "Not set" : formatMm(t.warningThresholdMm)}
                  </td>
                  <td>
                    {t.retreadsPermitted ? `${String(t.maxRetreads)} allowed` : "Not permitted"}
                  </td>
                  <td>{t.effectiveFrom === null ? "From the start" : asDate(t.effectiveFrom)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// FR-TEN-022: recorded by the tech team at onboarding, never in the app
// (U143 item 4).
function Consent({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  return (
    <section aria-labelledby="settings-consent">
      <h2 id="settings-consent">Consent</h2>
      <table className="tyres-table">
        <thead>
          <tr>
            <th scope="col">Purpose</th>
            <th scope="col">State</th>
            <th scope="col">Notice version</th>
            <th scope="col">Given</th>
          </tr>
        </thead>
        <tbody>
          {consentRows(body.consent).map(({ purpose, row }) => (
            <tr key={purpose}>
              <th scope="row">{consentPurposeLabel(purpose)}</th>
              <td>{consentStateLabel(row === null ? null : row.granted)}</td>
              <td>{row === null ? "None" : row.noticeVersion}</td>
              <td>{row === null ? "None" : asDate(row.givenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// FR-CFG-040, FR-CFG-042: the rows in force today; superseded ones stay in
// the database and are not shown.
function PriceList({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  return (
    <section aria-labelledby="settings-prices">
      <h2 id="settings-prices">Price list</h2>
      {body.priceList.length === 0 ? (
        <p className="note-card">No price list entries are in force.</p>
      ) : (
        <table className="tyres-table">
          <thead>
            <tr>
              <th scope="col">Size</th>
              <th scope="col">Brand</th>
              <th scope="col">Typical price</th>
              <th scope="col">Effective from</th>
            </tr>
          </thead>
          <tbody>
            {body.priceList.map((p) => (
              <tr key={`${p.sizeName}:${p.brandName ?? ""}`}>
                <th scope="row">{p.sizeName}</th>
                <td>{p.brandName ?? "Any brand"}</td>
                <td>{moneyText(p.typicalPrice, body.moneyVisible, body.fleet.currency)}</td>
                <td>{asDate(p.effectiveFrom)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CatalogueList({
  title,
  rows,
}: {
  title: string;
  rows: { id: string; name: string; platformCatalogueId: string | null }[];
}) {
  if (rows.length === 0) return null;
  return (
    <table className="tyres-table">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Lineage</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row">{r.name}</th>
            <td>{lineageLabel(r.platformCatalogueId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// FR-CFG-005: each entry from the platform catalogue or added for this
// fleet. Active entries only, as the receive form offers them.
function Catalogue({ catalogue }: { catalogue: TyreCatalogue }) {
  const empty = catalogue.sizes.length + catalogue.brands.length + catalogue.patterns.length === 0;
  return (
    <section aria-labelledby="settings-catalogue">
      <h2 id="settings-catalogue">Catalogue</h2>
      {empty ? (
        <p className="note-card">This fleet has no catalogue yet.</p>
      ) : (
        <>
          <CatalogueList title="Sizes" rows={catalogue.sizes} />
          <CatalogueList title="Brands" rows={catalogue.brands} />
          <CatalogueList title="Patterns" rows={catalogue.patterns} />
        </>
      )}
    </section>
  );
}

// FR-TEN-021, FR-CFG-005, FR-CFG-012, FR-CFG-021, FR-CFG-022, FR-TEN-022:
// a manager's read of what the tech team set at onboarding. Nothing here is
// editable; an admin surface is post-POC (U143 item 4).
export function FleetSettings() {
  const tenantKey = getDevTenantId() ?? "default";
  const settings = useQuery({ queryKey: fleetSettingsKey(tenantKey), queryFn: fetchFleetSettings });

  return (
    <section aria-labelledby="fleet-settings-heading" className="fleet-settings">
      <h1 className="page-title" id="fleet-settings-heading">
        Fleet settings
      </h1>

      {settings.isPending && <p>Loading…</p>}

      {settings.isError && (
        <div className="note-card" role="alert">
          <h2>Settings didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void settings.refetch()}>
            Retry
          </button>
        </div>
      )}

      {settings.isSuccess && (
        <>
          <Fleet body={settings.data} />
          <Thresholds body={settings.data} />
          <Consent body={settings.data} />
          <PriceList body={settings.data} />
          <Catalogue catalogue={settings.data.catalogue} />
        </>
      )}
    </section>
  );
}
