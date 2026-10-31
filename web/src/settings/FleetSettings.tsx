import { useQuery } from "@tanstack/react-query";

import type { TyreCatalogue } from "../api/catalogue";
import { getDevTenantId } from "../api/devTenant";
import { currencyName, moneyText } from "../api/money";
import { fetchFleetSettings, type ConsentCurrent, type FleetSettingsBody } from "../api/settings";
import { fleetSettingsKey } from "../fleet/unit/queryKeys";
import { useTenantDate } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { KeyValue } from "../ui/KeyValue";
import { PageHeader } from "../ui/PageHeader";
import { TableScroll } from "../ui/DataTable";
import { unitLabels } from "../units/units";
import {
  CONSENT_PURPOSES,
  consentPurposeLabel,
  consentStateLabel,
  lineageLabel,
  thresholdScopeLabel,
} from "../domain/vocabulary";
import { formatMm } from "../format/numbers";
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
    <Card title="Fleet">
      <KeyValue
        columns={3}
        items={[
          { label: "Timezone", value: body.fleet.timezone },
          { label: "Currency", value: currencyName(body.fleet.currency) },
          { label: "Pressure", value: units.pressure },
          { label: "Distance", value: units.distance },
          {
            label: "History",
            value:
              body.fleet.historyHorizon === null
                ? "No imported history"
                : `Live capture from ${asDate(body.fleet.historyHorizon)}`,
          },
        ]}
      />
    </Card>
  );
}

// FR-CFG-012 as revised by TYRE-299: the thresholds that exist. There is
// no scrap threshold (U68).
function Thresholds({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  return (
    <Card title="Tread thresholds" padding="none">
      {body.thresholds.length === 0 ? (
        <p className="fleet-card-empty">No tread thresholds are in force.</p>
      ) : (
        <TableScroll label="Tread thresholds table">
          <table className="fleet-table">
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col" data-align="right">
                  Removal threshold
                </th>
                <th scope="col" data-align="right">
                  Warning threshold
                </th>
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
                    <td data-align="right" data-mono="true">
                      {formatMm(t.removalThresholdMm)}
                    </td>
                    <td data-align="right" data-mono="true">
                      {t.warningThresholdMm === null ? "Not set" : formatMm(t.warningThresholdMm)}
                    </td>
                    <td>
                      {t.retreadsPermitted ? `${String(t.maxRetreads)} allowed` : "Not permitted"}
                    </td>
                    <td data-nowrap="true">
                      {t.effectiveFrom === null ? "From the start" : asDate(t.effectiveFrom)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Card>
  );
}

// FR-TEN-022: recorded by the tech team at onboarding, never in the app
// (U143 item 4).
function Consent({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  return (
    <Card title="Consent" padding="none">
      <TableScroll label="Consent table">
        <table className="fleet-table">
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
                <td data-mono="true">{row === null ? "None" : row.noticeVersion}</td>
                <td data-nowrap="true">{row === null ? "None" : asDate(row.givenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Card>
  );
}

// FR-CFG-040, FR-CFG-042: the rows in force today; superseded ones stay in
// the database and are not shown.
function PriceList({ body }: { body: FleetSettingsBody }) {
  const asDate = useTenantDate();
  return (
    <Card title="Price list" padding="none">
      {body.priceList.length === 0 ? (
        <p className="fleet-card-empty">No price list entries are in force.</p>
      ) : (
        <TableScroll label="Price list table">
          <table className="fleet-table">
            <thead>
              <tr>
                <th scope="col">Size</th>
                <th scope="col">Brand</th>
                <th scope="col" data-align="right">
                  Typical price
                </th>
                <th scope="col">Effective from</th>
              </tr>
            </thead>
            <tbody>
              {body.priceList.map((p) => (
                <tr key={`${p.sizeName}:${p.brandName ?? ""}`}>
                  <th scope="row" data-mono="true">
                    {p.sizeName}
                  </th>
                  <td>{p.brandName ?? "Any brand"}</td>
                  <td data-align="right" data-mono="true">
                    {moneyText(p.typicalPrice, body.moneyVisible, body.fleet.currency)}
                  </td>
                  <td data-nowrap="true">{asDate(p.effectiveFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Card>
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
    <TableScroll label={`${title} table`}>
      <table className="fleet-table">
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
    </TableScroll>
  );
}

// FR-CFG-005: each entry from the platform catalogue or added for this
// fleet. Active entries only, as the receive form offers them.
function Catalogue({ catalogue }: { catalogue: TyreCatalogue }) {
  const empty = catalogue.sizes.length + catalogue.brands.length + catalogue.patterns.length === 0;
  return (
    <Card title="Catalogue" padding="none">
      {empty ? (
        <p className="fleet-card-empty">This fleet has no catalogue yet.</p>
      ) : (
        <>
          <CatalogueList title="Sizes" rows={catalogue.sizes} />
          <CatalogueList title="Brands" rows={catalogue.brands} />
          <CatalogueList title="Patterns" rows={catalogue.patterns} />
        </>
      )}
    </Card>
  );
}

// FR-TEN-021, FR-CFG-005, FR-CFG-012, FR-CFG-021, FR-CFG-022, FR-TEN-022:
// a manager's read of what the tech team set at onboarding. Nothing here is
// editable; an admin surface is post-POC (U143 item 4).
export function FleetSettings() {
  const tenantKey = getDevTenantId() ?? "default";
  const settings = useQuery({
    queryKey: fleetSettingsKey(tenantKey),
    queryFn: fetchFleetSettings,
  });

  return (
    <section aria-labelledby="fleet-settings-heading" className="fleet-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader title={<span id="fleet-settings-heading">Fleet settings</span>} />

      {settings.isPending && <p>Loading…</p>}

      {settings.isError && (
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Settings didn&apos;t load</h2>}
          action={<Button onClick={() => void settings.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
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
