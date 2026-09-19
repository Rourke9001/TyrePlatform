package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// The analytics list routes (B7 spec B7.2, routes 5 to 10). Each relays one
// view or function under ViewFleet with depot scope composed in SQL, and
// names the clock its rows are judged on (U18). Millimetres, percentages,
// kilometres and days are float64 or ints, the house types for a
// measurement (capture.go); money does not appear on these routes.

// treadBandJSON is one band of app.v_tread_distribution. For a summed
// reading (a ScopeDepot actor's set of depots) pctOfGroup is recomputed in
// the same statement from the summed counts with the view's own formula,
// which is composition, not a second rule; for one row it is the row's.
type treadBandJSON struct {
	KeyName          *string  `json:"keyName"`
	BandOrdinal      int      `json:"bandOrdinal"`
	BandLabel        string   `json:"bandLabel"`
	LowerMm          float64  `json:"lowerMm"`
	UpperExclusiveMm *float64 `json:"upperExclusiveMm"`
	TyreCount        int64    `json:"tyreCount"`
	PctOfGroup       float64  `json:"pctOfGroup"`
}

var treadLevels = []string{"TENANT", "DEPOT", "VEHICLE"}
var positionClasses = []string{"RUNNING", "SPARE", "ALL"}

// Named apart from the allow-list order: ALL is the rollup BR-RPT-001 makes
// the default for composition reporting, and RUNNING and SPARE are the
// FR-RPT-005 disclosure beside it (000007).
const defaultPositionClass = "ALL"

func loadTreadDistribution(ctx context.Context, tx pgx.Tx, a auth.Actor, depot *uuid.UUID, level, class string) ([]treadBandJSON, error) {
	var sql string
	switch level {
	case "TENANT":
		sql = `
		SELECT NULL::text, v.band_ordinal, v.band_label, v.lower_mm::float8, v.upper_exclusive_mm::float8,
		       sum(v.tyre_count)::bigint,
		       round(sum(v.tyre_count) * 100.0 / NULLIF(sum(sum(v.tyre_count)) OVER (), 0), 2)::float8
		  FROM app.v_tread_distribution v
		 WHERE v.position_class = $2` + aggregateScope(a, depotByName) + `
		 GROUP BY v.band_ordinal, v.band_label, v.lower_mm, v.upper_exclusive_mm
		 ORDER BY v.band_ordinal`
	case "DEPOT":
		sql = `
		SELECT v.key_name, v.band_ordinal, v.band_label, v.lower_mm::float8, v.upper_exclusive_mm::float8,
		       v.tyre_count::bigint, v.pct_of_group::float8
		  FROM app.v_tread_distribution v
		 WHERE v.position_class = $2` + depotRowsScope(a, depotByName) + `
		 ORDER BY v.key_name, v.band_ordinal`
	default:
		// VEHICLE rows are keyed by fleet number; the unit must be in the
		// actor's source relation, as every vehicle-keyed read composes.
		sql = `
		SELECT v.key_name, v.band_ordinal, v.band_label, v.lower_mm::float8, v.upper_exclusive_mm::float8,
		       v.tyre_count::bigint, v.pct_of_group::float8
		  FROM app.v_tread_distribution v
		 WHERE v.position_class = $2 AND v.level = 'VEHICLE'
		   AND EXISTS (SELECT 1 FROM ` + unitSource(a) + ` sv WHERE sv.fleet_number = v.key_name)
		   AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM app.vehicle dv WHERE dv.fleet_number = v.key_name AND dv.home_depot_id = $1))
		 ORDER BY v.key_name, v.band_ordinal`
	}
	rows, err := tx.Query(ctx, sql, depot, class)
	if err != nil {
		return nil, fmt.Errorf("loading tread distribution: %w", err)
	}
	defer rows.Close()
	out := []treadBandJSON{}
	for rows.Next() {
		var b treadBandJSON
		if err := rows.Scan(&b.KeyName, &b.BandOrdinal, &b.BandLabel, &b.LowerMm, &b.UpperExclusiveMm, &b.TyreCount, &b.PctOfGroup); err != nil {
			return nil, fmt.Errorf("scanning tread band: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func treadDistribution(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		depot, err := uuidParam(q, "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		level, err := oneOfParam(q, "level", treadLevels...)
		if refuseInvalid(w, r, err) {
			return
		}
		class, err := oneOfParam(q, "positionClass", positionClasses...)
		if refuseInvalid(w, r, err) {
			return
		}
		if level == nil {
			level = &treadLevels[0]
		}
		if class == nil {
			c := defaultPositionClass
			class = &c
		}
		var body struct {
			Scope         scopeJSON       `json:"scope"`
			JudgedAt      string          `json:"judgedAt"`
			Level         string          `json:"level"`
			PositionClass string          `json:"positionClass"`
			Bands         []treadBandJSON `json:"bands"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			body.Scope, body.JudgedAt, body.Level, body.PositionClass = scopeFor(a, depot), "TODAY", *level, *class
			body.Bands, err = loadTreadDistribution(ctx, tx, a, depot, *level, *class)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// irregularWearJSON is one app.v_irregular_wear_ranking row at or over the
// configured spread (FR-EXC-035's own threshold, width_spread_warn_mm).
// rank is the view's, over the whole tenant, so a depot-scoped list shows
// where its tyres stand fleet-wide; rankScope says so.
type irregularWearJSON struct {
	TyreID           uuid.UUID `json:"tyreId"`
	DisplayCode      string    `json:"displayCode"`
	VehicleID        uuid.UUID `json:"vehicleId"`
	FleetNumber      string    `json:"fleetNumber"`
	PositionCode     string    `json:"positionCode"`
	IsSpare          bool      `json:"isSpare"`
	InspectionID     uuid.UUID `json:"inspectionId"`
	SubmittedAt      time.Time `json:"submittedAt"`
	WidthSpreadMm    float64   `json:"widthSpreadMm"`
	Measurements     []float64 `json:"measurements"`
	OrientationKnown bool      `json:"orientationKnown"`
	Rank             int       `json:"rank"`
}

func irregularWear(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		depot, err := uuidParam(q, "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		includeSpares := boolParam(q, "includeSpares")
		var body struct {
			Scope        scopeJSON           `json:"scope"`
			JudgedAt     string              `json:"judgedAt"`
			RankScope    string              `json:"rankScope"`
			SpreadWarnMm *float64            `json:"spreadWarnMm"`
			Tyres        []irregularWearJSON `json:"tyres"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			body.Scope, body.JudgedAt, body.RankScope = scopeFor(a, depot), "LATEST_READING", "TENANT"
			// The spread is read on its own so an unconfigured tenant gets
			// null and an empty list rather than a list judged against
			// nothing (rule 5).
			if err := tx.QueryRow(ctx,
				`SELECT (app.config_for($1, 'width_spread_warn_mm', now()) #>> '{}')::float8`, a.TenantID).Scan(&body.SpreadWarnMm); err != nil {
				return fmt.Errorf("resolving width_spread_warn_mm: %w", err)
			}
			body.Tyres = []irregularWearJSON{}
			if body.SpreadWarnMm == nil {
				return nil
			}
			rows, err := tx.Query(ctx, `
				SELECT r.tyre_id, r.display_code, r.vehicle_id, r.fleet_number, r.position_code, r.is_spare,
				       r.inspection_id, r.submitted_at, r.width_spread_mm::float8, r.measurements::float8[],
				       r.orientation_known, r.rank
				  FROM app.v_irregular_wear_ranking r
				 WHERE r.width_spread_mm >= $2::numeric
				   AND ($3::boolean OR NOT r.is_spare)`+unitScope(a, "r.vehicle_id")+`
				 ORDER BY r.rank, r.display_code`, depot, *body.SpreadWarnMm, includeSpares)
			if err != nil {
				return fmt.Errorf("listing irregular wear: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var t irregularWearJSON
				if err := rows.Scan(&t.TyreID, &t.DisplayCode, &t.VehicleID, &t.FleetNumber, &t.PositionCode, &t.IsSpare,
					&t.InspectionID, &t.SubmittedAt, &t.WidthSpreadMm, &t.Measurements, &t.OrientationKnown, &t.Rank); err != nil {
					return fmt.Errorf("scanning irregular wear: %w", err)
				}
				body.Tyres = append(body.Tyres, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// wearRateJSON is one app.v_tyre_wear_rate row. The status says why a rate
// is absent (BR-ANL-006 and the min-distance policy), so an absent rate is
// never read as zero wear.
type wearRateJSON struct {
	TyreID              uuid.UUID  `json:"tyreId"`
	DisplayCode         string     `json:"displayCode"`
	VehicleID           uuid.UUID  `json:"vehicleId"`
	FleetNumber         string     `json:"fleetNumber"`
	DepotName           *string    `json:"depotName"`
	PositionCode        string     `json:"positionCode"`
	IsSpare             bool       `json:"isSpare"`
	LaterReadAt         *time.Time `json:"laterReadAt"`
	LaterOdometer       *int64     `json:"laterOdometer"`
	LaterTreadMm        *float64   `json:"laterTreadMm"`
	EarlierReadAt       *time.Time `json:"earlierReadAt"`
	EarlierOdometer     *int64     `json:"earlierOdometer"`
	EarlierTreadMm      *float64   `json:"earlierTreadMm"`
	DistanceKm          *int64     `json:"distanceKm"`
	DaysBetween         *int       `json:"daysBetween"`
	MinDistanceKm       *int       `json:"minDistanceKm"`
	WearRateMmPer1000Km *float64   `json:"wearRateMmPer1000Km"`
	WearRateStatus      string     `json:"wearRateStatus"`
}

func wearRate(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		depot, err := uuidParam(r.URL.Query(), "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		var body struct {
			Scope    scopeJSON      `json:"scope"`
			JudgedAt string         `json:"judgedAt"`
			Tyres    []wearRateJSON `json:"tyres"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			body.Scope, body.JudgedAt = scopeFor(a, depot), "TODAY"
			rows, err := tx.Query(ctx, `
				SELECT w.tyre_id, w.display_code, w.vehicle_id, w.fleet_number, w.depot_name, w.position_code, w.is_spare,
				       w.later_read_at, w.later_odometer, w.later_tread_mm::float8,
				       w.earlier_read_at, w.earlier_odometer, w.earlier_tread_mm::float8,
				       w.distance_km, w.days_between, w.min_distance_km, w.wear_rate_mm_per_1000km::float8, w.wear_rate_status
				  FROM app.v_tyre_wear_rate w
				 WHERE true`+unitScope(a, "w.vehicle_id")+`
				 ORDER BY w.fleet_number, length(w.position_code), w.position_code`, depot)
			if err != nil {
				return fmt.Errorf("listing wear rates: %w", err)
			}
			defer rows.Close()
			body.Tyres = []wearRateJSON{}
			for rows.Next() {
				var t wearRateJSON
				if err := rows.Scan(&t.TyreID, &t.DisplayCode, &t.VehicleID, &t.FleetNumber, &t.DepotName, &t.PositionCode, &t.IsSpare,
					&t.LaterReadAt, &t.LaterOdometer, &t.LaterTreadMm, &t.EarlierReadAt, &t.EarlierOdometer, &t.EarlierTreadMm,
					&t.DistanceKm, &t.DaysBetween, &t.MinDistanceKm, &t.WearRateMmPer1000Km, &t.WearRateStatus); err != nil {
					return fmt.Errorf("scanning wear rate: %w", err)
				}
				body.Tyres = append(body.Tyres, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// forecastWindowJSON is the horizon and start date the forecast was judged
// on. horizonDays comes from ?horizonDays= or forecast_horizon_days; null
// with unavailable NO_HORIZON when neither exists (rule 5). from defaults to
// the tenant's today (U34), echoed so the client never guesses the day.
type forecastWindowJSON struct {
	HorizonDays *int    `json:"horizonDays"`
	From        string  `json:"from"`
	Unavailable *string `json:"unavailable"`
}

func resolveForecastWindow(ctx context.Context, tx pgx.Tx, a auth.Actor, horizon *int, from *string) (forecastWindowJSON, error) {
	var w forecastWindowJSON
	err := tx.QueryRow(ctx, `
		SELECT COALESCE($2::int, (app.config_for($1, 'forecast_horizon_days', now()) #>> '{}')::int),
		       COALESCE($3::date, app.tenant_today((SELECT timezone FROM app.tenant)))::text`,
		a.TenantID, horizon, from).Scan(&w.HorizonDays, &w.From)
	if err != nil {
		return w, fmt.Errorf("resolving the forecast window: %w", err)
	}
	if w.HorizonDays == nil {
		reason := "NO_HORIZON"
		w.Unavailable = &reason
	}
	return w, nil
}

// removalForecastJSON is one app.v_removal_forecast row. Dates are ranges,
// never a point (CHG-113, CHG-115), and basis says what produced them.
type removalForecastJSON struct {
	TyreID              uuid.UUID  `json:"tyreId"`
	DisplayCode         string     `json:"displayCode"`
	VehicleID           uuid.UUID  `json:"vehicleId"`
	FleetNumber         string     `json:"fleetNumber"`
	DepotName           *string    `json:"depotName"`
	PositionCode        string     `json:"positionCode"`
	IsSpare             bool       `json:"isSpare"`
	CurrentTreadMm      *float64   `json:"currentTreadMm"`
	LaterReadAt         *time.Time `json:"laterReadAt"`
	RemovalThresholdMm  *float64   `json:"removalThresholdMm"`
	WearRateMmPerMonth  *float64   `json:"wearRateMmPerMonth"`
	WearRateMmPer1000Km *float64   `json:"wearRateMmPer1000Km"`
	ReadingCount        *int64     `json:"readingCount"`
	EarliestRemovalDate *string    `json:"earliestRemovalDate"`
	LatestRemovalDate   *string    `json:"latestRemovalDate"`
	Basis               *string    `json:"basis"`
	ForecastStatus      string     `json:"forecastStatus"`
}

// forecastWithinWhere is the predicate suite section 59e pins the count
// with, and the one app.removal_forecast_within does not carry: FORECAST
// rows only, since a tyre already at the threshold is the register's, not
// the forecast's. $1 depot, $2 horizon, $3 from, $4 includeSpares.
const forecastWithinWhere = `f.forecast_status = 'FORECAST'
		   AND f.earliest_removal_date <= $3::date + $2::int
		   AND ($4::boolean OR NOT f.is_spare)`

func removalForecast(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		depot, err := uuidParam(q, "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		horizon, err := positiveIntParam(q, "horizonDays")
		if refuseInvalid(w, r, err) {
			return
		}
		from, err := dateParam(q, "from")
		if refuseInvalid(w, r, err) {
			return
		}
		includeSpares := boolParam(q, "includeSpares")
		var body struct {
			Scope    scopeJSON `json:"scope"`
			JudgedAt string    `json:"judgedAt"`
			forecastWindowJSON
			Tyres []removalForecastJSON `json:"tyres"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			body.Scope, body.JudgedAt = scopeFor(a, depot), "TODAY"
			body.forecastWindowJSON, err = resolveForecastWindow(ctx, tx, a, horizon, from)
			if err != nil {
				return err
			}
			body.Tyres = []removalForecastJSON{}
			if body.HorizonDays == nil {
				return nil
			}
			rows, err := tx.Query(ctx, `
				SELECT f.tyre_id, f.display_code, f.vehicle_id, f.fleet_number, f.depot_name, f.position_code, f.is_spare,
				       f.current_tread_mm::float8, f.later_read_at, f.removal_threshold_mm::float8,
				       f.wear_rate_mm_per_month::float8, f.wear_rate_mm_per_1000km::float8, f.reading_count::bigint,
				       f.earliest_removal_date::text, f.latest_removal_date::text, f.basis, f.forecast_status
				  FROM app.v_removal_forecast f
				 WHERE `+forecastWithinWhere+unitScope(a, "f.vehicle_id")+`
				 ORDER BY f.earliest_removal_date, f.fleet_number, length(f.position_code), f.position_code`,
				depot, *body.HorizonDays, body.From, includeSpares)
			if err != nil {
				return fmt.Errorf("listing the removal forecast: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var t removalForecastJSON
				if err := rows.Scan(&t.TyreID, &t.DisplayCode, &t.VehicleID, &t.FleetNumber, &t.DepotName, &t.PositionCode, &t.IsSpare,
					&t.CurrentTreadMm, &t.LaterReadAt, &t.RemovalThresholdMm, &t.WearRateMmPerMonth, &t.WearRateMmPer1000Km, &t.ReadingCount,
					&t.EarliestRemovalDate, &t.LatestRemovalDate, &t.Basis, &t.ForecastStatus); err != nil {
					return fmt.Errorf("scanning forecast row: %w", err)
				}
				body.Tyres = append(body.Tyres, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// inflationBandJSON is one of app.inflation_compliance's five rows, always
// present and zero-filled (BR-RPT-004: readings are the denominator).
// pctOfClassified is null, never 0, when the period classified nothing: a
// share of no readings is undefined, and rendering it as zero would read as
// "none of them were in band" (NFR-PRO-002).
type inflationBandJSON struct {
	BandOrdinal       int      `json:"bandOrdinal"`
	BandKey           string   `json:"bandKey"`
	ReadingCount      int64    `json:"readingCount"`
	TyreCount         int64    `json:"tyreCount"`
	PctOfClassified   *float64 `json:"pctOfClassified"`
	ColdCount         int64    `json:"coldCount"`
	HotCount          int64    `json:"hotCount"`
	UnknownCount      int64    `json:"unknownCount"`
	TotalReadings     int64    `json:"totalReadings"`
	TotalTyres        int64    `json:"totalTyres"`
	UnclassifiedCount int64    `json:"unclassifiedCount"`
}

// inflationComplianceJSON is FR-DSH-007's period, half-open on submitted_at
// (from inclusive, to exclusive, both UTC, as the function reads them).
// unavailable names why there are no bands: NO_WINDOW when the tenant has
// no inflation_compliance_window_days and the request named no period
// (rule 5, U28); TENANT_ONLY for a depot-scoped actor, since the function
// has no depot dimension and B7.2 carries no migration to add one (U32).
type inflationComplianceJSON struct {
	From        *string             `json:"from"`
	To          *string             `json:"to"`
	WindowDays  *int                `json:"windowDays"`
	Unavailable *string             `json:"unavailable"`
	Bands       []inflationBandJSON `json:"bands"`
}

func loadInflationCompliance(ctx context.Context, tx pgx.Tx, a auth.Actor, depot *uuid.UUID, from, to *string) (inflationComplianceJSON, error) {
	out := inflationComplianceJSON{Bands: []inflationBandJSON{}}
	// A depot-narrowed request is refused the same way a depot-scoped actor
	// is: the function counts the tenant's readings, so answering one under
	// a body whose scope says DEPOT would state a tenant figure as a depot's
	// (NFR-PRO-002).
	if depot != nil || a.Scope() != auth.ScopeTenant {
		reason := "TENANT_ONLY"
		out.Unavailable = &reason
		return out, nil
	}
	if from == nil {
		// The window ends tomorrow on the tenant's calendar, exclusive, so
		// today's readings are inside it.
		err := tx.QueryRow(ctx, `
			SELECT w.days,
			       (t.today + 1 - w.days)::text,
			       (t.today + 1)::text
			  FROM (SELECT (app.config_for($1, 'inflation_compliance_window_days', now()) #>> '{}')::int AS days) w,
			       (SELECT app.tenant_today(timezone) AS today FROM app.tenant) t`,
			a.TenantID).Scan(&out.WindowDays, &out.From, &out.To)
		if err != nil {
			return out, fmt.Errorf("resolving the inflation window: %w", err)
		}
		if out.WindowDays == nil {
			reason := "NO_WINDOW"
			out.Unavailable, out.From, out.To = &reason, nil, nil
			return out, nil
		}
	} else {
		out.From, out.To = from, to
	}
	rows, err := tx.Query(ctx, `
		SELECT band_ordinal, band_key, reading_count, tyre_count, pct_of_classified::float8,
		       cold_count, hot_count, unknown_count, total_readings, total_tyres, unclassified_count
		  FROM app.inflation_compliance($1::date, $2::date)
		 ORDER BY band_ordinal`, *out.From, *out.To)
	if err != nil {
		return out, fmt.Errorf("loading inflation compliance: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var b inflationBandJSON
		if err := rows.Scan(&b.BandOrdinal, &b.BandKey, &b.ReadingCount, &b.TyreCount, &b.PctOfClassified,
			&b.ColdCount, &b.HotCount, &b.UnknownCount, &b.TotalReadings, &b.TotalTyres, &b.UnclassifiedCount); err != nil {
			return out, fmt.Errorf("scanning inflation band: %w", err)
		}
		out.Bands = append(out.Bands, b)
	}
	return out, rows.Err()
}

func inflationCompliance(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		depot, err := uuidParam(q, "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		from, err := dateParam(q, "from")
		if refuseInvalid(w, r, err) {
			return
		}
		to, err := dateParam(q, "to")
		if refuseInvalid(w, r, err) {
			return
		}
		if (from == nil) != (to == nil) {
			writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
				"a period names both from and to (to is exclusive), or neither for the configured window")
			return
		}
		var body struct {
			Scope    scopeJSON `json:"scope"`
			JudgedAt string    `json:"judgedAt"`
			inflationComplianceJSON
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			body.Scope, body.JudgedAt = scopeFor(a, depot), "PERIOD"
			body.inflationComplianceJSON, err = loadInflationCompliance(ctx, tx, a, depot, from, to)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// spareJSON is one app.v_spare_tyre_age row: a spare is judged on age, on
// the tenant's calendar (FR-RPT-041, Q21); the depth rides along and never
// ranks, which is why this list is its own route and never a tread panel.
type spareJSON struct {
	TyreID            uuid.UUID  `json:"tyreId"`
	DisplayCode       string     `json:"displayCode"`
	VehicleID         uuid.UUID  `json:"vehicleId"`
	FleetNumber       string     `json:"fleetNumber"`
	PositionCode      string     `json:"positionCode"`
	ReceivedDate      *string    `json:"receivedDate"`
	AgeDays           *int       `json:"ageDays"`
	LastMeasuredAt    *time.Time `json:"lastMeasuredAt"`
	MeasuredSource    *string    `json:"measuredSource"`
	DaysSinceMeasured *int       `json:"daysSinceMeasured"`
	CurrentTreadMm    *float64   `json:"currentTreadMm"`
}

func listSpares(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		depot, err := uuidParam(r.URL.Query(), "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		var body struct {
			Scope    scopeJSON   `json:"scope"`
			JudgedAt string      `json:"judgedAt"`
			Spares   []spareJSON `json:"spares"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			body.Scope, body.JudgedAt = scopeFor(a, depot), "TENANT_TODAY"
			rows, err := tx.Query(ctx, `
				SELECT sp.tyre_id, sp.display_code, sp.vehicle_id, sp.fleet_number, sp.position_code,
				       sp.received_date::text, sp.age_days, sp.last_measured_at, sp.measured_source,
				       sp.days_since_measured, sp.current_tread_mm::float8
				  FROM app.v_spare_tyre_age sp
				 WHERE true`+unitScope(a, "sp.vehicle_id")+`
				 ORDER BY sp.age_days DESC NULLS LAST, sp.display_code`, depot)
			if err != nil {
				return fmt.Errorf("listing spares: %w", err)
			}
			defer rows.Close()
			body.Spares = []spareJSON{}
			for rows.Next() {
				var t spareJSON
				if err := rows.Scan(&t.TyreID, &t.DisplayCode, &t.VehicleID, &t.FleetNumber, &t.PositionCode,
					&t.ReceivedDate, &t.AgeDays, &t.LastMeasuredAt, &t.MeasuredSource, &t.DaysSinceMeasured, &t.CurrentTreadMm); err != nil {
					return fmt.Errorf("scanning spare: %w", err)
				}
				body.Spares = append(body.Spares, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}
