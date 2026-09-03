// The unit surface (TYRE-92/TYRE-94): a manager-facing view of one unit's
// positions and current fitments, its fitment history, the fleet-wide
// open-fitments list the Fitments screen drives from, and the two writes that
// edit a unit — its descriptive fields and tags, and its status. The split
// between those two writes is the point: the descriptive edit is a plain
// UPDATE because no rule governs it, and the status change is a call into
// app.set_vehicle_status because rules do (D5).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// openFitmentJSON is what a position's current occupant looks like. It
// carries no money: nothing here is a monetary field, so unlike tyreJSONFor
// there is no ViewValuation branch to gate — the place one would go, if a
// money field is ever added, is a canSeeMoney parameter on unitByID mirroring
// tyres.go's projection.
type openFitmentJSON struct {
	FitmentID        string  `json:"fitmentId"`
	TyreID           string  `json:"tyreId"`
	DisplayCode      string  `json:"displayCode"`
	FittedAt         string  `json:"fittedAt"`
	FittedOdometer   *int64  `json:"fittedOdometer"`
	FittedTreadMm    *string `json:"fittedTreadMm"`
	MountOrientation string  `json:"mountOrientation"`
	TyreStatus       string  `json:"tyreStatus"`
	RetreadCount     int     `json:"retreadCount"`
	SizeName         *string `json:"sizeName"`
	LastTreadMm      *string `json:"lastTreadMm"`
}

// unitPositionJSON is one row of the unit's configuration, carrying its
// current occupant if any. Side and Slot are NULL for a spare, mirroring
// app.position's own spare_has_no_geometry constraint (000001).
type unitPositionJSON struct {
	ID         string           `json:"id"`
	Code       string           `json:"code"`
	Sequence   int              `json:"sequence"`
	AxleNumber *int             `json:"axleNumber"`
	AxleClass  string           `json:"axleClass"`
	Side       *string          `json:"side"`
	Slot       *string          `json:"slot"`
	IsSpare    bool             `json:"isSpare"`
	Fitment    *openFitmentJSON `json:"fitment"`
}

// unitJSON is the GET /api/vehicles/{id} body, and the unit PATCH's response.
// Registration is *string rather than a bare string: app.vehicle.registration
// is a nullable column (000001), and tyres.go's own idiom is to scan a
// nullable column into a pointer rather than coerce it (lesson 2026-08-26).
type unitJSON struct {
	ID                string             `json:"id"`
	FleetNumber       string             `json:"fleetNumber"`
	Registration      *string            `json:"registration"`
	Description       *string            `json:"description"`
	BodyType          *string            `json:"bodyType"`
	UnitDescriptor    *string            `json:"unitDescriptor"`
	UnitKind          *string            `json:"unitKind"`
	Status            string             `json:"status"`
	ConfigurationID   string             `json:"configurationId"`
	ConfigurationName string             `json:"configurationName"`
	HomeDepotID       *string            `json:"homeDepotId"`
	OperatingGroupID  *string            `json:"operatingGroupId"`
	Tags              []string           `json:"tags"`
	HasHistory        bool               `json:"hasHistory"`
	RemovalReasons    []string           `json:"removalReasons"`
	HasOdometer       bool               `json:"hasOdometer"`
	Positions         []unitPositionJSON `json:"positions"`
}

// fitmentHistoryJSON is one row of GET /api/vehicles/{id}/fitments — every
// fitment the unit has ever carried, open or closed. DistanceSource is never
// null (distance_source carries NOT NULL DEFAULT 'UNAVAILABLE', 000011);
// DistanceKm is nil when the source is UNAVAILABLE — INFERRED is written by
// nothing until OI-31 (000033) — which is CR-012's pairing: a distance is
// never shown without the provenance it was derived under.
type fitmentHistoryJSON struct {
	FitmentID        string  `json:"fitmentId"`
	TyreID           string  `json:"tyreId"`
	DisplayCode      string  `json:"displayCode"`
	PositionCode     string  `json:"positionCode"`
	FittedAt         string  `json:"fittedAt"`
	RemovedAt        *string `json:"removedAt"`
	FittedOdometer   *int64  `json:"fittedOdometer"`
	RemovedOdometer  *int64  `json:"removedOdometer"`
	FittedTreadMm    *string `json:"fittedTreadMm"`
	RemovedTreadMm   *string `json:"removedTreadMm"`
	RemovalReason    *string `json:"removalReason"`
	DistanceKm       *int64  `json:"distanceKm"`
	DistanceSource   string  `json:"distanceSource"`
	MountOrientation string  `json:"mountOrientation"`
}

// fleetFitmentJSON is one row of GET /api/fitments?open=true, the Fitments
// screen. DaysFitted is computed in SQL, in the tenant's own civil calendar
// (rule 6) — never in Go from time.Now(), which would answer in the runner's
// zone instead of the fleet's.
type fleetFitmentJSON struct {
	FitmentID    string `json:"fitmentId"`
	VehicleID    string `json:"vehicleId"`
	FleetNumber  string `json:"fleetNumber"`
	PositionCode string `json:"positionCode"`
	TyreID       string `json:"tyreId"`
	DisplayCode  string `json:"displayCode"`
	FittedAt     string `json:"fittedAt"`
	DaysFitted   int    `json:"daysFitted"`
}

type depotJSON struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// depotTypes mirrors app.depot_type (000001) so an unrecognised ?type= value
// is refused in Go, before a transaction opens (ADR-0013 decision 5), rather
// than reaching the database as a cast that raises 22P02.
var depotTypes = map[string]bool{
	"DEPOT":              true,
	"STORE":              true,
	"RETREADER":          true,
	"BREAKDOWN_SUPPLIER": true,
}

// unitByID is the one query shape for a manager-facing unit read. The unit
// PATCH answers with this same body (D6), so it stays free of HTTP concerns
// and returns pgx.ErrNoRows — the same value a genuinely missing id produces —
// when RLS hides the unit, rather than a distinguishable error: whether the
// unit is another tenant's or does not exist at all is not the caller's to
// learn (ADR-0011).
func unitByID(ctx context.Context, tx pgx.Tx, id uuid.UUID) (unitJSON, error) {
	var u unitJSON
	var vehID, configID uuid.UUID
	var homeDepotID, operatingGroupID *uuid.UUID

	// hasHistory is exactly TY008's own predicate (000028's
	// reject_configuration_change_with_history): any fitment, inspection or
	// reading row is history the trigger would refuse to move the unit's
	// configuration or kind out from under (D4). Keep the two agreeing —
	// a unit the screen shows as "has history" must be one the trigger
	// would also refuse.
	//
	// hasOdometer below is the same tension: it is the exact negation of
	// app.require_odometer_where_unit_has_one's own exemption (000025's
	// fitment_odometer_matches_unit_kind exempts a NULL kind and a TRAILER).
	// One predicate stated in two languages — should either move without the
	// other, the fit form hides the odometer field for a unit whose write
	// TY009 then refuses, or asks for one no rule wants.
	err := tx.QueryRow(ctx, `
		SELECT v.id, v.fleet_number, v.registration, v.description, v.body_type, v.unit_descriptor,
		       v.unit_kind::text, v.status::text, v.configuration_id, ac.name,
		       v.home_depot_id, v.operating_group_id,
		       EXISTS (SELECT 1 FROM app.fitment f WHERE f.vehicle_id = v.id)
		         OR EXISTS (SELECT 1 FROM app.inspection i WHERE i.vehicle_id = v.id)
		         OR EXISTS (SELECT 1 FROM app.reading r WHERE r.vehicle_id = v.id),
		       (v.unit_kind IS NOT NULL AND v.unit_kind <> 'TRAILER')
		  FROM app.vehicle v
		  JOIN app.axle_configuration ac ON ac.id = v.configuration_id
		 WHERE v.id = $1`, id).
		Scan(&vehID, &u.FleetNumber, &u.Registration, &u.Description, &u.BodyType, &u.UnitDescriptor,
			&u.UnitKind, &u.Status, &configID, &u.ConfigurationName,
			&homeDepotID, &operatingGroupID, &u.HasHistory, &u.HasOdometer)
	if err != nil {
		return unitJSON{}, err
	}
	u.ID = vehID.String()
	u.ConfigurationID = configID.String()
	if homeDepotID != nil {
		s := homeDepotID.String()
		u.HomeDepotID = &s
	}
	if operatingGroupID != nil {
		s := operatingGroupID.String()
		u.OperatingGroupID = &s
	}

	// FR-VEH-041: the unit's current tag set, alphabetical for a stable render.
	u.Tags = []string{}
	trows, err := tx.Query(ctx, `
		SELECT vt.name FROM app.vehicle_tag_map vtm
		  JOIN app.vehicle_tag vt ON vt.id = vtm.tag_id
		 WHERE vtm.vehicle_id = $1
		 ORDER BY vt.name`, id)
	if err != nil {
		return unitJSON{}, fmt.Errorf("loading unit tags: %w", err)
	}
	for trows.Next() {
		var tag string
		if err := trows.Scan(&tag); err != nil {
			trows.Close()
			return unitJSON{}, fmt.Errorf("scanning unit tag: %w", err)
		}
		u.Tags = append(u.Tags, tag)
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		return unitJSON{}, fmt.Errorf("reading unit tags: %w", err)
	}

	// Rule 5's removal-reason vocabulary: the newest row not in the future
	// (FR-CFG-051), the identical lookup app.remove_tyre's own SELECT performs
	// (000033) — read here so the screen can render the picker before a
	// removal is ever opened. An absent key is absence, not a fault: the
	// tenant simply has not configured reasons yet.
	u.RemovalReasons = []string{}
	var raw []byte
	err = tx.QueryRow(ctx, `
		SELECT value FROM app.configuration
		 WHERE key = 'removal_reasons' AND effective_from <= now()
		 ORDER BY effective_from DESC LIMIT 1`).Scan(&raw)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &u.RemovalReasons); err != nil {
			return unitJSON{}, fmt.Errorf("decoding removal reasons: %w", err)
		}
	case errors.Is(err, pgx.ErrNoRows):
		// configured nowhere yet — leave the empty slice above.
	default:
		return unitJSON{}, fmt.Errorf("loading removal reasons: %w", err)
	}

	// One row per position with its open fitment if any — the same LEFT JOIN
	// chain capture.go's loadCaptureContext already establishes for the
	// driver's context, reused here for the manager's read (D4).
	u.Positions = []unitPositionJSON{}
	prows, err := tx.Query(ctx, `
		SELECT p.id, p.code, p.sequence, p.axle_number, p.axle_class::text, p.side::text, p.slot::text, p.is_spare,
		       f.id, f.tyre_id, t.display_code, f.fitted_at, f.fitted_odometer, f.fitted_tread_mm::text,
		       f.mount_orientation::text, t.status::text, t.retread_count, s.name, t.last_tread_mm::text
		  FROM app.vehicle v
		  JOIN app.position p ON p.configuration_id = v.configuration_id
		  LEFT JOIN app.fitment f ON f.position_id = p.id AND f.vehicle_id = v.id AND f.removed_at IS NULL
		  LEFT JOIN app.tyre t ON t.id = f.tyre_id
		  LEFT JOIN app.tyre_size s ON s.id = t.size_id
		 WHERE v.id = $1
		 ORDER BY p.sequence`, id)
	if err != nil {
		return unitJSON{}, fmt.Errorf("loading unit positions: %w", err)
	}
	defer prows.Close()
	for prows.Next() {
		var (
			posID                                     uuid.UUID
			code, axleClass                           string
			sequence                                  int
			axleNumber                                *int
			side, slot                                *string
			isSpare                                   bool
			fitmentID, tyreID                         *uuid.UUID
			displayCode, mountOrientation, tyreStatus *string
			fittedAt                                  *time.Time
			fittedOdometer                            *int64
			fittedTreadMm, sizeName, lastTreadMm      *string
			retreadCount                              *int
		)
		if err := prows.Scan(&posID, &code, &sequence, &axleNumber, &axleClass, &side, &slot, &isSpare,
			&fitmentID, &tyreID, &displayCode, &fittedAt, &fittedOdometer, &fittedTreadMm,
			&mountOrientation, &tyreStatus, &retreadCount, &sizeName, &lastTreadMm); err != nil {
			return unitJSON{}, fmt.Errorf("scanning unit position: %w", err)
		}
		pos := unitPositionJSON{
			ID: posID.String(), Code: code, Sequence: sequence, AxleNumber: axleNumber,
			AxleClass: axleClass, Side: side, Slot: slot, IsSpare: isSpare,
		}
		if fitmentID != nil {
			pos.Fitment = &openFitmentJSON{
				FitmentID:        fitmentID.String(),
				TyreID:           tyreID.String(),
				DisplayCode:      *displayCode,
				FittedAt:         fittedAt.UTC().Format(time.RFC3339),
				FittedOdometer:   fittedOdometer,
				FittedTreadMm:    fittedTreadMm,
				MountOrientation: *mountOrientation,
				TyreStatus:       *tyreStatus,
				RetreadCount:     *retreadCount,
				SizeName:         sizeName,
				LastTreadMm:      lastTreadMm,
			}
		}
		u.Positions = append(u.Positions, pos)
	}
	if err := prows.Err(); err != nil {
		return unitJSON{}, fmt.Errorf("reading unit positions: %w", err)
	}

	return u, nil
}

// getUnit is the manager-facing unit read (D4, D6). A read answers a missing
// or RLS-hidden unit as 404 not_found — never TY012, which is the write
// path's own vocabulary for the identical condition (000033's fit_tyre and
// friends); this handler writes nothing, so it composes its own refusal
// rather than reaching for a write-surface code.
func getUnit(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var body unitJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			u, err := unitByID(ctx, tx, vehicleID)
			if errors.Is(err, pgx.ErrNoRows) {
				return refusalError{refusal{
					status:  http.StatusNotFound,
					code:    codeNotFound,
					message: "no such unit in this fleet",
				}}
			}
			if err != nil {
				return fmt.Errorf("loading unit %s: %w", vehicleID, err)
			}
			body = u
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// listUnitFitments is FR-FIT's history read (D6): every fitment the unit has
// ever carried, most recent first, open and closed alike. No existence check
// on the vehicle id beyond RLS — app.fitment carries its own tenant_id, so a
// missing or cross-tenant vehicle id simply matches no rows (an empty list,
// not a 404); only the single-unit read composes that refusal.
func listUnitFitments(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		out := []fitmentHistoryJSON{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT f.id, f.tyre_id, t.display_code, p.code, f.fitted_at, f.removed_at,
				       f.fitted_odometer, f.removed_odometer, f.fitted_tread_mm, f.removed_tread_mm,
				       f.removal_reason, f.distance_km, f.distance_source::text, f.mount_orientation::text
				  FROM app.fitment f
				  JOIN app.position p ON p.id = f.position_id
				  JOIN app.tyre t     ON t.id = f.tyre_id
				 WHERE f.vehicle_id = $1
				 ORDER BY f.fitted_at DESC`, vehicleID)
			if err != nil {
				return fmt.Errorf("listing fitment history for %s: %w", vehicleID, err)
			}
			defer rows.Close()
			for rows.Next() {
				var (
					fitmentID, tyreID                uuid.UUID
					displayCode, positionCode        string
					fittedAt                         time.Time
					removedAt                        *time.Time
					fittedOdometer, removedOdometer  *int64
					fittedTreadMm, removedTreadMm    *string
					removalReason                    *string
					distanceKm                       *int64
					distanceSource, mountOrientation string
				)
				if err := rows.Scan(&fitmentID, &tyreID, &displayCode, &positionCode, &fittedAt, &removedAt,
					&fittedOdometer, &removedOdometer, &fittedTreadMm, &removedTreadMm,
					&removalReason, &distanceKm, &distanceSource, &mountOrientation); err != nil {
					return fmt.Errorf("scanning fitment history row: %w", err)
				}
				row := fitmentHistoryJSON{
					FitmentID: fitmentID.String(), TyreID: tyreID.String(), DisplayCode: displayCode,
					PositionCode: positionCode, FittedAt: fittedAt.UTC().Format(time.RFC3339),
					FittedOdometer: fittedOdometer, RemovedOdometer: removedOdometer,
					FittedTreadMm: fittedTreadMm, RemovedTreadMm: removedTreadMm,
					RemovalReason: removalReason, DistanceKm: distanceKm, DistanceSource: distanceSource,
					MountOrientation: mountOrientation,
				}
				if removedAt != nil {
					ts := removedAt.UTC().Format(time.RFC3339)
					row.RemovedAt = &ts
				}
				out = append(out, row)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// listOpenFitments is the Fitments screen's fleet-wide read (D6). open=true
// is required for now: an unfiltered "every fitment ever" read is not a
// screen this slice builds, so the query parameter is refused rather than
// silently ignored.
//
// Depot scope is deliberately not applied here, mirroring listTyres — TYRE-76
// owns widening or narrowing this read, not this slice (D6).
func listOpenFitments(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if r.URL.Query().Get("open") != "true" {
			writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
				"only ?open=true is supported for now")
			return
		}
		out := []fleetFitmentJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			// daysFitted is (today - fitted_at's day) in the tenant's own civil
			// calendar (rule 6), both resolved through app.tenant_today so the
			// timezone conversion happens exactly once (000015).
			rows, err := tx.Query(ctx, `
				SELECT f.id, f.vehicle_id, v.fleet_number, p.code, f.tyre_id, t.display_code, f.fitted_at,
				       (app.tenant_today(tn.timezone) - app.tenant_today(tn.timezone, f.fitted_at))::int
				  FROM app.fitment f
				  JOIN app.vehicle v  ON v.id = f.vehicle_id
				  JOIN app.position p ON p.id = f.position_id
				  JOIN app.tyre t     ON t.id = f.tyre_id
				  JOIN app.tenant tn  ON tn.id = f.tenant_id
				 WHERE f.removed_at IS NULL
				 ORDER BY v.fleet_number, p.code`)
			if err != nil {
				return fmt.Errorf("listing open fitments: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var (
					fitmentID, vehicleID, tyreID           uuid.UUID
					fleetNumber, positionCode, displayCode string
					fittedAt                               time.Time
					daysFitted                             int
				)
				if err := rows.Scan(&fitmentID, &vehicleID, &fleetNumber, &positionCode, &tyreID, &displayCode,
					&fittedAt, &daysFitted); err != nil {
					return fmt.Errorf("scanning open fitment row: %w", err)
				}
				out = append(out, fleetFitmentJSON{
					FitmentID: fitmentID.String(), VehicleID: vehicleID.String(), FleetNumber: fleetNumber,
					PositionCode: positionCode, TyreID: tyreID.String(), DisplayCode: displayCode,
					FittedAt: fittedAt.UTC().Format(time.RFC3339), DaysFitted: daysFitted,
				})
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// listDepots is the dispatch and return forms' picker (D6). Gated on
// ManageAssets, like the other asset reads (listAxleConfigurations,
// listTyres): a depot list is only useful to someone who may act on it.
// Only active depots are returned — a retired depot is not a valid
// destination for a new dispatch.
func listDepots(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		depotType := r.URL.Query().Get("type")
		if depotType != "" && !depotTypes[depotType] {
			writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
				"type must be one of DEPOT, STORE, RETREADER, BREAKDOWN_SUPPLIER")
			return
		}
		out := []depotJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			sql := `SELECT id, name, type::text FROM app.depot WHERE active = true`
			var args []any
			if depotType != "" {
				sql += ` AND type = $1::app.depot_type`
				args = append(args, depotType)
			}
			sql += ` ORDER BY name`
			rows, err := tx.Query(ctx, sql, args...)
			if err != nil {
				return fmt.Errorf("listing depots: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var id uuid.UUID
				var name, typeText string
				if err := rows.Scan(&id, &name, &typeText); err != nil {
					return fmt.Errorf("scanning depot: %w", err)
				}
				out = append(out, depotJSON{ID: id.String(), Name: name, Type: typeText})
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// patchUnitRequest is the descriptive edit (D5). Every field is a pointer
// because absence is this request's own vocabulary: a key the caller did not
// send leaves its column exactly as it stands, which is what lets a form
// submit only what someone actually changed. The two nullable ids also take
// "" to clear, the one intent a bare pointer cannot express; the five text
// columns have no clear at all — a unit's description is edited through this
// surface, never emptied.
//
// configuration_id and unit_kind are deliberately not fields here, and
// decodeJSONStrict refuses any key matching none of them — as encoding/json
// matches, case-insensitively, so no spelling of either gets through — which
// is what keeps TY008 (000028) unreachable from the API (D5,
// docs/implementation-order.md §B5).
type patchUnitRequest struct {
	FleetNumber      *string `json:"fleetNumber"`
	Registration     *string `json:"registration"`
	Description      *string `json:"description"`
	BodyType         *string `json:"bodyType"`
	UnitDescriptor   *string `json:"unitDescriptor"`
	HomeDepotID      *string `json:"homeDepotId"`
	OperatingGroupID *string `json:"operatingGroupId"`
	// FR-VEH-041, U6: nil leaves the unit's tags alone, an empty array clears
	// them. A plain []string could not tell those two apart.
	Tags *[]string `json:"tags"`
}

// patchUnitArgs is the validated request. The two ids are carried as text
// rather than *uuid.UUID because one parameter has to express three states —
// unchanged, cleared, set — and NULL is already taken by "unchanged".
type patchUnitArgs struct {
	fleetNumber, registration, description, bodyType, unitDescriptor *string
	homeDepotID, operatingGroupID                                    *string
	tags                                                             *[]string
}

// optionalIDOrClear reads a nullable id with the three states above. A value
// that is neither absent nor empty must parse as a uuid here rather than
// reach the ::uuid cast as a 22P02 naming no field at all (ADR-0013
// decision 5).
func optionalIDOrClear(field string, raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return &trimmed, nil
	}
	if _, err := uuidField(field, trimmed); err != nil {
		return nil, err
	}
	return &trimmed, nil
}

// cleanTags bounds the count, trims, refuses a blank name and drops repeats
// while keeping the caller's order. De-duplication is case-sensitive because
// the constraint it stands in front of is: app.vehicle_tag's UNIQUE
// (tenant_id, name) holds "Reefer" and "REEFER" as two names, so folding case
// here would quietly merge two labels a fleet deliberately keeps apart.
func cleanTags(in []string) ([]string, error) {
	// Counted before the de-duplication, not after: what is bounded is the
	// request, and fifty repeats of one name is the same work to read as fifty
	// distinct ones.
	if len(in) > maxTagsPerPatch {
		return nil, invalid("tags", fmt.Sprintf("may name at most %d names in one edit", maxTagsPerPatch))
	}
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, raw := range in {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, invalid("tags", "may not contain a blank name")
		}
		if len(name) > maxTextLen {
			return nil, invalid("tags", "contains a name that is too long")
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out, nil
}

func (b patchUnitRequest) validate() (patchUnitArgs, error) {
	var a patchUnitArgs

	// fleet_number is NOT NULL (000001), so a blank one is asking for
	// something the column cannot hold; answering "unchanged" would hide that
	// from whoever typed it. The other four text fields take text()'s
	// reading, where blank is absence — D5 gives them no clear.
	if b.FleetNumber != nil {
		fleetNumber := strings.TrimSpace(*b.FleetNumber)
		if fleetNumber == "" {
			return a, invalid("fleetNumber", "may not be blank")
		}
		if len(fleetNumber) > maxTextLen {
			return a, invalid("fleetNumber", "is too long")
		}
		a.fleetNumber = &fleetNumber
	}

	var err error
	if a.registration, err = text("registration", b.Registration); err != nil {
		return a, err
	}
	if a.description, err = text("description", b.Description); err != nil {
		return a, err
	}
	if a.bodyType, err = text("bodyType", b.BodyType); err != nil {
		return a, err
	}
	if a.unitDescriptor, err = text("unitDescriptor", b.UnitDescriptor); err != nil {
		return a, err
	}
	if a.homeDepotID, err = optionalIDOrClear("homeDepotId", b.HomeDepotID); err != nil {
		return a, err
	}
	if a.operatingGroupID, err = optionalIDOrClear("operatingGroupId", b.OperatingGroupID); err != nil {
		return a, err
	}
	if b.Tags != nil {
		tags, err := cleanTags(*b.Tags)
		if err != nil {
			return a, err
		}
		a.tags = &tags
	}
	return a, nil
}

// patchUnit is FR-VEH-041's descriptive edit (D5, ADR-0013 decision 1): one
// parameterised UPDATE, because no rule governs these columns. Fleet-number
// uniqueness is a constraint that already states itself (23505 →
// conflictCodes), and the two rules that do govern a unit — its configuration
// and kind once it has history (TY008), and its status (FR-VEH-005) — are
// reached through neither this body nor this statement.
//
// The UPDATE runs even when the body names no column, because it is doing two
// further jobs. It is the existence check — RLS is what makes "no such unit"
// and "another tenant's unit" the same 404 (ADR-0011) — and its row lock is
// what serialises two concurrent tag replacements on one unit, which a bare
// SELECT in its place would not. A tags-only edit therefore still touches the
// vehicle row, and writes no audit entry for it: app.audit_row_change returns
// early when an UPDATE leaves the row identical, so nothing is logged that
// claims a column moved when none did. The tag map rows it does change are
// not audited — vehicle_audited is on app.vehicle alone (000035).
func patchUnit(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var body patchUnitRequest
		if !decodeJSONStrict(w, r, &body) {
			return
		}
		args, err := body.validate()
		if refuseInvalid(w, r, err) {
			return
		}

		var out unitJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			// COALESCE for the text columns: a nil parameter leaves the column
			// alone. The two ids cannot use it, because NULL is a value they
			// may legitimately be set to and COALESCE would read that as
			// "unchanged" — hence the three-way CASE.
			tag, err := tx.Exec(ctx, `
				UPDATE app.vehicle SET
				       fleet_number       = COALESCE($2::text, fleet_number),
				       registration       = COALESCE($3::text, registration),
				       description        = COALESCE($4::text, description),
				       body_type          = COALESCE($5::text, body_type),
				       unit_descriptor    = COALESCE($6::text, unit_descriptor),
				       home_depot_id      = CASE WHEN $7::text IS NULL THEN home_depot_id
				                                 WHEN $7::text = ''     THEN NULL
				                                 ELSE $7::uuid END,
				       operating_group_id = CASE WHEN $8::text IS NULL THEN operating_group_id
				                                 WHEN $8::text = ''     THEN NULL
				                                 ELSE $8::uuid END
				 WHERE id = $1`,
				vehicleID, args.fleetNumber, args.registration, args.description, args.bodyType,
				args.unitDescriptor, args.homeDepotID, args.operatingGroupID)
			if err != nil {
				return fmt.Errorf("editing unit %s: %w", vehicleID, err)
			}
			if tag.RowsAffected() == 0 {
				return refusalError{refusal{
					status:  http.StatusNotFound,
					code:    codeNotFound,
					message: "no such unit in this fleet",
				}}
			}
			if args.tags != nil {
				if err := replaceUnitTags(ctx, tx, vehicleID, *args.tags); err != nil {
					return err
				}
			}
			out, err = unitByID(ctx, tx, vehicleID)
			if err != nil {
				return fmt.Errorf("reading back unit %s: %w", vehicleID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// replaceUnitTags is U6's replace-all, in the caller's own transaction so no
// other session ever sees the unit briefly untagged. It is the one write on
// this surface that deletes a row, and the named exception to ADR-0013
// decision 7: a map row is a unit's current label rather than a record of
// anything that happened, which is why 000035 restores DELETE for
// app.vehicle_tag_map alone — a tag NAME is shared across units, and one
// unit's edit must never delete the name the rest of the fleet still carries.
//
// tenant_id is app.current_tenant_id() and never the request's (ADR-0013
// decision 2). The DO UPDATE is not a change: it is what makes RETURNING
// answer with the existing row's id instead of nothing at all.
func replaceUnitTags(ctx context.Context, tx pgx.Tx, vehicleID uuid.UUID, tags []string) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM app.vehicle_tag_map WHERE vehicle_id = $1`, vehicleID); err != nil {
		return fmt.Errorf("clearing the tags of unit %s: %w", vehicleID, err)
	}
	for _, name := range tags {
		var tagID uuid.UUID
		if err := tx.QueryRow(ctx,
			`INSERT INTO app.vehicle_tag (tenant_id, name) VALUES (app.current_tenant_id(), $1)
			 ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
			 RETURNING id`, name).Scan(&tagID); err != nil {
			return fmt.Errorf("resolving a tag name for unit %s: %w", vehicleID, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id)
			 VALUES (app.current_tenant_id(), $1, $2)`, vehicleID, tagID); err != nil {
			return fmt.Errorf("tagging unit %s: %w", vehicleID, err)
		}
	}
	return nil
}

// setUnitStatusRequest is app.set_vehicle_status's body. Reason is *string so
// an absent one reaches the function's own DEFAULT NULL: a disposal is the
// transition that requires it, and which transitions require what is
// FR-VEH-005's rule, held in the function and not restated here.
type setUnitStatusRequest struct {
	Status string  `json:"status"`
	Reason *string `json:"reason"`
}

// setUnitStatus is FR-VEH-005/FR-VEH-006's write. Status is deliberately not
// a column the PATCH above updates: rules govern the move — DISPOSED is
// terminal, a disposal needs an empty unit (INV-2) and a stated reason, a
// no-op is refused so the audit log carries no row claiming a change that did
// not happen — and a bare UPDATE walks past every one of them, so the whole
// transition is app.set_vehicle_status's (000035).
//
// Nothing is narrowed here but the shape: an unrecognised status reaches the
// enum cast as 22P02, which submitStatus already answers 422, so this handler
// keeps no second copy of app.vehicle_status to drift from it.
func setUnitStatus(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var body setUnitStatusRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		status, err := requiredText("status", body.Status)
		if refuseInvalid(w, r, err) {
			return
		}

		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			// TY012 and TY016 arrive via refusalForPgError with their messages
			// intact; each names the rule that refused the transition, which
			// is the whole reason those messages are written in SQL.
			if _, err := tx.Exec(ctx,
				`SELECT app.set_vehicle_status($1, $2::app.vehicle_status, $3)`,
				vehicleID, status, body.Reason); err != nil {
				return fmt.Errorf("setting the status of unit %s: %w", vehicleID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
