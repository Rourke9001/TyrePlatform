package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// The fleet settings page is read-only: the tech team sets each of these at
// onboarding, outside the app (U143 item 4). Every section relays a view of
// migration 000059 or the catalogue reads, and decides nothing here.

type fleetSettingsFleetJSON struct {
	Timezone     string `json:"timezone"`
	Currency     string `json:"currency"`
	PressureUnit string `json:"pressureUnit"`
	DistanceUnit string `json:"distanceUnit"`
	// FR-TEN-021: the date live capture starts, or null for a fleet with no
	// imported history.
	HistoryHorizon *string `json:"historyHorizon"`
}

// effectiveFrom is null for a scope's -infinity baseline: it is in force at
// every instant, so it has no date to show (SRS 5.1, errata E1).
type fleetSettingsThresholdJSON struct {
	OperatingGroupName *string  `json:"operatingGroupName"`
	AxleClass          *string  `json:"axleClass"`
	RemovalThresholdMm float64  `json:"removalThresholdMm"`
	WarningThresholdMm *float64 `json:"warningThresholdMm"`
	MaxRetreads        int      `json:"maxRetreads"`
	RetreadsPermitted  bool     `json:"retreadsPermitted"`
	EffectiveFrom      *string  `json:"effectiveFrom"`
}

type fleetSettingsConsentJSON struct {
	Purpose       string `json:"purpose"`
	Granted       bool   `json:"granted"`
	NoticeVersion string `json:"noticeVersion"`
	GivenAt       string `json:"givenAt"`
}

// typicalPrice is null when money is hidden; moneyVisible tells hidden from
// absent, as the analytics reads do (api/CLAUDE.md).
type fleetSettingsPriceJSON struct {
	SizeName      string  `json:"sizeName"`
	BrandName     *string `json:"brandName"`
	TypicalPrice  *string `json:"typicalPrice"`
	EffectiveFrom string  `json:"effectiveFrom"`
}

type fleetSettingsJSON struct {
	Fleet        fleetSettingsFleetJSON       `json:"fleet"`
	Thresholds   []fleetSettingsThresholdJSON `json:"thresholds"`
	Consent      []fleetSettingsConsentJSON   `json:"consent"`
	PriceList    []fleetSettingsPriceJSON     `json:"priceList"`
	Catalogue    tyreCatalogueJSON            `json:"catalogue"`
	MoneyVisible bool                         `json:"moneyVisible"`
}

// fleetSettings serves the settings page (FR-TEN-021, FR-CFG-005,
// FR-CFG-012, FR-CFG-021, FR-CFG-022, FR-TEN-022, FR-CFG-042), gated on
// ManageConfig. The catalogue is the receive form's own read
// (loadTyreCatalogue), active rows only.
func fleetSettings(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil: an empty section is [], never null.
		out := fleetSettingsJSON{
			Thresholds: []fleetSettingsThresholdJSON{},
			Consent:    []fleetSettingsConsentJSON{},
			PriceList:  []fleetSettingsPriceJSON{},
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageConfig); err != nil {
				return err
			}
			out.MoneyVisible = a.Can(auth.ViewValuation)
			if err := tx.QueryRow(ctx,
				`SELECT timezone, currency::text, pressure_unit, distance_unit, history_horizon::text
				   FROM app.tenant WHERE id = app.current_tenant_id()`).
				Scan(&out.Fleet.Timezone, &out.Fleet.Currency, &out.Fleet.PressureUnit,
					&out.Fleet.DistanceUnit, &out.Fleet.HistoryHorizon); err != nil {
				return fmt.Errorf("reading the fleet's settings: %w", err)
			}
			var err error
			if out.Thresholds, err = loadThresholdsInForce(ctx, tx); err != nil {
				return err
			}
			if out.Consent, err = loadConsentCurrent(ctx, tx); err != nil {
				return err
			}
			if out.PriceList, err = loadPriceListInForce(ctx, tx, out.MoneyVisible); err != nil {
				return err
			}
			out.Catalogue, err = loadTyreCatalogue(ctx, tx)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// The fleet-wide row first, then operating groups, then axle classes.
func loadThresholdsInForce(ctx context.Context, tx pgx.Tx) ([]fleetSettingsThresholdJSON, error) {
	rows, err := tx.Query(ctx, `
		SELECT v.operating_group_name, v.axle_class::text, v.retread_threshold_mm::float8,
		       v.warning_threshold_mm::float8, v.max_retreads, v.retreads_permitted,
		       CASE WHEN isfinite(v.effective_from) THEN v.effective_from END
		  FROM app.v_threshold_policy_in_force v
		 ORDER BY v.operating_group_id IS NOT NULL, v.operating_group_name,
		          v.axle_class IS NOT NULL, v.axle_class`)
	if err != nil {
		return nil, fmt.Errorf("listing thresholds in force: %w", err)
	}
	defer rows.Close()
	out := []fleetSettingsThresholdJSON{}
	for rows.Next() {
		var row fleetSettingsThresholdJSON
		var from *time.Time
		if err := rows.Scan(&row.OperatingGroupName, &row.AxleClass, &row.RemovalThresholdMm,
			&row.WarningThresholdMm, &row.MaxRetreads, &row.RetreadsPermitted, &from); err != nil {
			return nil, fmt.Errorf("scanning a threshold in force: %w", err)
		}
		if from != nil {
			at := from.UTC().Format(time.RFC3339)
			row.EffectiveFrom = &at
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// A purpose never recorded has no row here; the page names it as not
// recorded.
func loadConsentCurrent(ctx context.Context, tx pgx.Tx) ([]fleetSettingsConsentJSON, error) {
	rows, err := tx.Query(ctx, `
		SELECT v.purpose_code, v.granted, v.notice_version, v.occurred_at
		  FROM app.v_tenant_consent_current v
		 ORDER BY v.purpose_code`)
	if err != nil {
		return nil, fmt.Errorf("listing current consent: %w", err)
	}
	defer rows.Close()
	out := []fleetSettingsConsentJSON{}
	for rows.Next() {
		var row fleetSettingsConsentJSON
		var given time.Time
		if err := rows.Scan(&row.Purpose, &row.Granted, &row.NoticeVersion, &given); err != nil {
			return nil, fmt.Errorf("scanning current consent: %w", err)
		}
		row.GivenAt = given.UTC().Format(time.RFC3339)
		out = append(out, row)
	}
	return out, rows.Err()
}

func loadPriceListInForce(ctx context.Context, tx pgx.Tx, canSeeMoney bool) ([]fleetSettingsPriceJSON, error) {
	rows, err := tx.Query(ctx, `
		SELECT v.size_name, v.brand_name, v.typical_price::text, v.effective_from::text
		  FROM app.v_tyre_price_list_in_force v
		 ORDER BY length(v.size_name), v.size_name, v.brand_name NULLS FIRST`)
	if err != nil {
		return nil, fmt.Errorf("listing the price list in force: %w", err)
	}
	defer rows.Close()
	out := []fleetSettingsPriceJSON{}
	for rows.Next() {
		var row fleetSettingsPriceJSON
		if err := rows.Scan(&row.SizeName, &row.BrandName, &row.TypicalPrice, &row.EffectiveFrom); err != nil {
			return nil, fmt.Errorf("scanning a price in force: %w", err)
		}
		if !canSeeMoney {
			row.TypicalPrice = nil
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
