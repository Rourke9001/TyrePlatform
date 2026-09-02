package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

// plantUnitFixture plants one axle configuration carrying two road positions
// off a single axle plus a spare, and two vehicles sharing it — "mine" (a
// HORSE) and "other" (a TRAILER, so hasOdometer's false branch and an
// UNAVAILABLE distance both have a realistic source — 000025's rule exempts
// a TRAILER, and two-thirds of the tyres on a superlink carry exactly this
// shape). Position ids repeat across units of the same configuration
// (lesson 2026-08-26), so a test asserting the unit read shows only its own
// fitments needs both vehicles present and a fitment planted on each at the
// SAME position id to be a real assertion rather than a vacuous one.
func plantUnitFixture(t *testing.T, ctx context.Context, admin *pgx.Conn, label string) (tenantID, mine, other, leftPos, rightPos, sparePos uuid.UUID) {
	t.Helper()
	tenantID, _ = plantTenant(t, ctx, admin, label)
	suffix := uuid.NewString()[:8]

	var configID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, $2, 'unit test rig', 1) RETURNING id`,
		tenantID, "UNITTEST-"+suffix,
	).Scan(&configID))

	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.position
		   (tenant_id, configuration_id, code, sequence, axle_number, axle_class, side, slot, is_spare)
		 VALUES ($1, $2, '1L', 1, 1, 'STEER'::app.axle_class, 'LEFT'::app.side, 'SINGLE'::app.fitment_slot, false)
		 RETURNING id`,
		tenantID, configID,
	).Scan(&leftPos))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.position
		   (tenant_id, configuration_id, code, sequence, axle_number, axle_class, side, slot, is_spare)
		 VALUES ($1, $2, '1R', 2, 1, 'STEER'::app.axle_class, 'RIGHT'::app.side, 'SINGLE'::app.fitment_slot, false)
		 RETURNING id`,
		tenantID, configID,
	).Scan(&rightPos))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.position (tenant_id, configuration_id, code, sequence, axle_class, is_spare)
		 VALUES ($1, $2, 'SP1', 3, 'SPARE'::app.axle_class, true) RETURNING id`,
		tenantID, configID,
	).Scan(&sparePos))

	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 VALUES ($1, $2, $3, 'HORSE'::app.unit_kind) RETURNING id`,
		tenantID, "UNIT-MINE-"+suffix, configID,
	).Scan(&mine))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 VALUES ($1, $2, $3, 'TRAILER'::app.unit_kind) RETURNING id`,
		tenantID, "UNIT-OTHER-"+suffix, configID,
	).Scan(&other))

	return
}

// plantRemovalReasons plants rule 5's removal-reason vocabulary — the
// configuration key app.remove_tyre itself resolves and unitByID reads for
// the screen's picker.
func plantRemovalReasons(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, reasons ...string) {
	t.Helper()
	raw, err := json.Marshal(reasons)
	require.NoError(t, err)
	_, err = admin.Exec(ctx,
		`INSERT INTO app.configuration (tenant_id, key, value, effective_from)
		 VALUES ($1, 'removal_reasons', $2::jsonb, now() - interval '1 hour')`,
		tenantID, string(raw))
	require.NoError(t, err)
}

// int64Ptr is a plain literal-to-pointer helper: app.fit_tyre's odometer and
// app.remove_tyre's odometer are both optional, and a test naming a TRAILER
// fitment needs to pass nil for one without declining an addressable literal.
func int64Ptr(v int64) *int64 { return &v }

// fitTyreViaActor calls app.fit_tyre inside an actor-bound transaction: the
// admin connection carries no tenant in its session state, and the function
// reads app.current_tenant_id(), so it cannot run on that connection at all.
func fitTyreViaActor(t *testing.T, ctx context.Context, s *store.Store, tenantID, actorID, tyreID, vehicleID, positionID uuid.UUID, treadMm, orientation string, odometer *int64) uuid.UUID {
	t.Helper()
	var fitmentID uuid.UUID
	require.NoError(t, s.InActorTx(ctx, tenantID, actorID, func(tx pgx.Tx, _ auth.Actor) error {
		return tx.QueryRow(ctx,
			`SELECT fitment_id FROM app.fit_tyre($1, $2, $3, $4::numeric, $5::app.mount_orientation, $6)`,
			tyreID, vehicleID, positionID, treadMm, orientation, odometer,
		).Scan(&fitmentID)
	}))
	return fitmentID
}

// fitTyreAtViaActor is fitTyreViaActor with an explicit occurredAt, for a
// test that needs a fitment planted a known number of tenant-civil-days in
// the past rather than "now" (daysFitted's own denominator). reason is
// forwarded as app.fitment_instant_ok's backdate justification — required
// once occurredAt is more than 24 hours behind now(), harmless otherwise.
func fitTyreAtViaActor(t *testing.T, ctx context.Context, s *store.Store, tenantID, actorID, tyreID, vehicleID, positionID uuid.UUID, treadMm, orientation string, odometer *int64, occurredAt time.Time, reason string) uuid.UUID {
	t.Helper()
	var fitmentID uuid.UUID
	require.NoError(t, s.InActorTx(ctx, tenantID, actorID, func(tx pgx.Tx, _ auth.Actor) error {
		return tx.QueryRow(ctx,
			`SELECT fitment_id FROM app.fit_tyre($1, $2, $3, $4::numeric, $5::app.mount_orientation, $6, $7, $8)`,
			tyreID, vehicleID, positionID, treadMm, orientation, odometer, occurredAt, reason,
		).Scan(&fitmentID)
	}))
	return fitmentID
}

// removeTyreViaActor closes a fitment through app.remove_tyre, the same
// actor-tx route fitTyreViaActor uses. odometer nil produces an UNAVAILABLE
// distance; a non-nil odometer at or above the fitted one produces MEASURED.
func removeTyreViaActor(t *testing.T, ctx context.Context, s *store.Store, tenantID, actorID, fitmentID uuid.UUID, reason, treadMm string, odometer *int64) {
	t.Helper()
	require.NoError(t, s.InActorTx(ctx, tenantID, actorID, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`SELECT app.remove_tyre($1, $2, $3::numeric, $4)`,
			fitmentID, reason, treadMm, odometer)
		return err
	}))
}

// tenantDaysAgo answers a timestamptz exactly N tenant-civil-days behind the
// tenant's own today, computed entirely in SQL from app.tenant_today so a Go
// wall-clock offset (which would answer in the runner's zone, not the
// tenant's) is never the thing under test.
func tenantDaysAgo(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, days int) time.Time {
	t.Helper()
	var at time.Time
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT (app.tenant_today(timezone) - $2::int)::timestamp AT TIME ZONE timezone
		   FROM app.tenant WHERE id = $1`,
		tenantID, days,
	).Scan(&at))
	return at
}

type unitPositionBody struct {
	ID         string  `json:"id"`
	Code       string  `json:"code"`
	Sequence   int     `json:"sequence"`
	AxleNumber *int    `json:"axleNumber"`
	AxleClass  string  `json:"axleClass"`
	Side       *string `json:"side"`
	Slot       *string `json:"slot"`
	IsSpare    bool    `json:"isSpare"`
	Fitment    *struct {
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
	} `json:"fitment"`
}

type unitBody struct {
	ID                string             `json:"id"`
	FleetNumber       string             `json:"fleetNumber"`
	Registration      *string            `json:"registration"`
	UnitKind          *string            `json:"unitKind"`
	Status            string             `json:"status"`
	ConfigurationID   string             `json:"configurationId"`
	ConfigurationName string             `json:"configurationName"`
	Tags              []string           `json:"tags"`
	HasHistory        bool               `json:"hasHistory"`
	RemovalReasons    []string           `json:"removalReasons"`
	HasOdometer       bool               `json:"hasOdometer"`
	Positions         []unitPositionBody `json:"positions"`
}

// A fitted position carries its occupant's code and orientation, an empty
// one carries null, hasHistory follows TY008's own predicate once a fitment
// exists, removalReasons answers once configured, and hasOdometer follows
// unit_kind (000025's rule: NOT NULL and not TRAILER) — proven on both
// branches: "mine" is a HORSE and reads true, "other" is a TRAILER sharing
// the same position id and reads false, so an implementation that dropped
// the TRAILER exclusion (leaving only "IS NOT NULL") could not pass both.
func TestGetUnitCarriesPositionsAndCurrentFitments(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "unit-fitments")
	plantRemovalReasons(t, ctx, admin, tenantID, "WORN", "DAMAGED")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	mineTyre := plantTyre(t, ctx, admin, tenantID, "UNIT-TYRE-MINE", nil)
	otherTyre := plantTyre(t, ctx, admin, tenantID, "UNIT-TYRE-OTHER", nil)
	fitTyreViaActor(t, ctx, s, tenantID, controller, mineTyre, mine, leftPos, "9.5", "MARK_OUTBOARD", int64Ptr(40000))
	// Same position id as mine's leftPos (lesson 2026-08-26): if the query
	// keyed on position_id alone this fitment would leak into mine's read.
	// other is a TRAILER, so no fitted odometer is the realistic shape
	// (000025) rather than a value this test has to supply.
	fitTyreViaActor(t, ctx, s, tenantID, controller, otherTyre, other, leftPos, "8.0", "MARK_INBOARD", nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := get(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body unitBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

	require.Equal(t, mine.String(), body.ID)
	require.True(t, body.HasHistory, "a fitment exists for this unit")
	require.True(t, body.HasOdometer, "unit_kind HORSE has an odometer (000025)")
	require.ElementsMatch(t, []string{"WORN", "DAMAGED"}, body.RemovalReasons)
	require.Len(t, body.Positions, 3, "left, right and spare")

	var sawLeft, sawRight, sawSpare bool
	for _, p := range body.Positions {
		switch p.Code {
		case "1L":
			sawLeft = true
			require.NotNil(t, p.Fitment, "mine's leftPos carries its own fitment")
			require.Equal(t, mineTyre.String(), p.Fitment.TyreID)
			require.Equal(t, "UNIT-TYRE-MINE", p.Fitment.DisplayCode)
			require.Equal(t, "MARK_OUTBOARD", p.Fitment.MountOrientation)
			require.NotEqual(t, otherTyre.String(), p.Fitment.TyreID,
				"other's fitment at the same position id must not leak into mine's read")
		case "1R":
			sawRight = true
			require.Nil(t, p.Fitment, "an empty position carries a null fitment")
		case "SP1":
			sawSpare = true
			require.Nil(t, p.Fitment)
			require.True(t, p.IsSpare)
			require.Nil(t, p.AxleNumber)
			require.Nil(t, p.Side)
		}
	}
	require.True(t, sawLeft && sawRight && sawSpare, "all three positions were seen")

	otherRec := get(t, h, "/api/vehicles/"+other.String(), tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, otherRec.Code, otherRec.Body.String())
	var otherBody unitBody
	require.NoError(t, json.Unmarshal(otherRec.Body.Bytes(), &otherBody))
	require.False(t, otherBody.HasOdometer, "unit_kind TRAILER has no odometer (000025)'s false branch")
	require.True(t, otherBody.HasHistory, "other's own fitment above is history too")
}

// A missing or another tenant's unit answers 404 not_found, never TY012 —
// this handler writes nothing, so it must not reach for the write path's
// vocabulary. Tenant A's own read is asserted 200 first, on the identical
// unit and an actor holding the identical capability, so a missing route (or
// any other blanket failure) cannot pass the 404 assertion that follows for
// the wrong reason. The tenant-B reader genuinely holds ViewFleet, so that
// 404 is provably RLS and not a capability refusal (lesson 2026-08-26).
func TestGetUnitIsTenantScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, fleetA := plantTenantWithVehicle(t, ctx, admin, "unit-scope-a")
	userA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	tenantB, _ := plantTenant(t, ctx, admin, "unit-scope-b")
	userB := plantUser(t, ctx, admin, tenantB, auth.RoleController)

	var vehicleA uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantA, fleetA,
	).Scan(&vehicleA))

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	own := get(t, h, "/api/vehicles/"+vehicleA.String(), tenantA.String(), userA.String())
	require.Equal(t, http.StatusOK, own.Code, own.Body.String())

	rec := get(t, h, "/api/vehicles/"+vehicleA.String(), tenantB.String(), userB.String())
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())

	var body struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "not_found", body.Code)
}

type fitmentHistoryBody struct {
	FitmentID        string  `json:"fitmentId"`
	TyreID           string  `json:"tyreId"`
	DisplayCode      string  `json:"displayCode"`
	PositionCode     string  `json:"positionCode"`
	FittedAt         string  `json:"fittedAt"`
	RemovedAt        *string `json:"removedAt"`
	FittedOdometer   *int64  `json:"fittedOdometer"`
	RemovedOdometer  *int64  `json:"removedOdometer"`
	RemovalReason    *string `json:"removalReason"`
	DistanceKm       *int64  `json:"distanceKm"`
	DistanceSource   string  `json:"distanceSource"`
	MountOrientation string  `json:"mountOrientation"`
}

// CR-012: a closed row never shows a distance without the provenance it was
// derived under. The MEASURED row is planted on "mine", a HORSE, with both
// odometers given; the UNAVAILABLE row is planted on "other", a TRAILER,
// with neither — the realistic source of an UNAVAILABLE distance (000025's
// rule exempts a TRAILER; two-thirds of the tyres on a superlink carry
// exactly this shape), not a unit_kind edited out from under a HORSE, which
// TY008 forbids one row later regardless. Each unit's own /fitments read is
// asserted separately so both shapes are proven without needing one unit to
// carry both.
func TestUnitFitmentHistoryCarriesProvenanceWithDistance(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, leftPos, rightPos, _ := plantUnitFixture(t, ctx, admin, "fitment-history")
	plantRemovalReasons(t, ctx, admin, tenantID, "WORN", "DAMAGED")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	measuredTyre := plantTyre(t, ctx, admin, tenantID, "HIST-MEASURED", nil)
	measuredFit := fitTyreViaActor(t, ctx, s, tenantID, controller, measuredTyre, mine, leftPos, "10.0", "MARK_OUTBOARD", int64Ptr(10000))
	removeTyreViaActor(t, ctx, s, tenantID, controller, measuredFit, "WORN", "4.0", int64Ptr(10500))

	measuredRec := get(t, h, "/api/vehicles/"+mine.String()+"/fitments", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, measuredRec.Code, measuredRec.Body.String())
	var measuredRows []fitmentHistoryBody
	require.NoError(t, json.Unmarshal(measuredRec.Body.Bytes(), &measuredRows))
	require.Len(t, measuredRows, 1)
	require.NotNil(t, measuredRows[0].RemovedAt)
	require.Equal(t, "MEASURED", measuredRows[0].DistanceSource)
	require.NotNil(t, measuredRows[0].DistanceKm)
	require.Equal(t, int64(500), *measuredRows[0].DistanceKm)

	unavailableTyre := plantTyre(t, ctx, admin, tenantID, "HIST-UNAVAILABLE", nil)
	unavailableFit := fitTyreViaActor(t, ctx, s, tenantID, controller, unavailableTyre, other, rightPos, "10.0", "MARK_OUTBOARD", nil)
	removeTyreViaActor(t, ctx, s, tenantID, controller, unavailableFit, "DAMAGED", "6.0", nil)

	unavailableRec := get(t, h, "/api/vehicles/"+other.String()+"/fitments", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, unavailableRec.Code, unavailableRec.Body.String())
	var unavailableRows []fitmentHistoryBody
	require.NoError(t, json.Unmarshal(unavailableRec.Body.Bytes(), &unavailableRows))
	require.Len(t, unavailableRows, 1)
	require.NotNil(t, unavailableRows[0].RemovedAt)
	require.Equal(t, "UNAVAILABLE", unavailableRows[0].DistanceSource)
	require.Nil(t, unavailableRows[0].DistanceKm)
}

type fleetFitmentBody struct {
	FitmentID    string `json:"fitmentId"`
	VehicleID    string `json:"vehicleId"`
	FleetNumber  string `json:"fleetNumber"`
	PositionCode string `json:"positionCode"`
	TyreID       string `json:"tyreId"`
	DisplayCode  string `json:"displayCode"`
	FittedAt     string `json:"fittedAt"`
	DaysFitted   int    `json:"daysFitted"`
}

// GET /api/fitments?open=true reads across every unit in the tenant, not one
// vehicle at a time — the Fitments screen's whole point — and stays inside
// tenant isolation while doing it. daysFitted is asserted exactly, against a
// fitment planted at tenant-today minus N (never a Go wall-clock offset,
// which would answer in the runner's zone rather than the tenant's) — a
// bare "not negative" assertion would pass an implementation that answered
// the wrong number every time it was not literally negative.
func TestOpenFitmentsAreFleetWide(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, leftPos, rightPos, _ := plantUnitFixture(t, ctx, admin, "open-fitments")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	mineTyre := plantTyre(t, ctx, admin, tenantID, "OPEN-TYRE-MINE", nil)
	otherTyre := plantTyre(t, ctx, admin, tenantID, "OPEN-TYRE-OTHER", nil)
	mineFit := fitTyreAtViaActor(t, ctx, s, tenantID, controller, mineTyre, mine, leftPos, "9.0", "MARK_OUTBOARD",
		int64Ptr(20000), tenantDaysAgo(t, ctx, admin, tenantID, 3), "backdated for fixture repeatability")
	// other is a TRAILER (no odometer, 000025) planted today (day 0), so the
	// two rows exercise different DaysFitted values and different odometer
	// nullability in the same read.
	otherFit := fitTyreAtViaActor(t, ctx, s, tenantID, controller, otherTyre, other, rightPos, "9.0", "MARK_OUTBOARD",
		nil, tenantDaysAgo(t, ctx, admin, tenantID, 0), "backdated for fixture repeatability")

	// A second tenant's open fitment, planted by raw INSERT on the admin
	// connection (the superuser bypasses RLS on write) so this test also
	// proves the fleet-wide read stays inside tenant isolation rather than
	// only proving it is not single-vehicle-scoped.
	tenantB, mineB, _, leftPosB, _, _ := plantUnitFixture(t, ctx, admin, "open-fitments-b")
	tyreB := plantTyre(t, ctx, admin, tenantB, "OPEN-TYRE-B", nil)
	var fitmentB uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
		                         fitted_odometer, fitted_tread_mm, mount_orientation)
		 VALUES ($1, $2, $3, $4, now(), 1000, 9.0, 'MARK_OUTBOARD'::app.mount_orientation)
		 RETURNING id`,
		tenantB, tyreB, mineB, leftPosB,
	).Scan(&fitmentB))

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := get(t, h, "/api/fitments?open=true", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var rows []fleetFitmentBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))

	byFitment := map[string]fleetFitmentBody{}
	for _, row := range rows {
		byFitment[row.FitmentID] = row
	}
	mineRow, ok := byFitment[mineFit.String()]
	require.True(t, ok, "mine's open fitment is in the fleet-wide list")
	require.Equal(t, 3, mineRow.DaysFitted, "daysFitted is exact, computed in the tenant's own civil calendar")

	otherRow, ok := byFitment[otherFit.String()]
	require.True(t, ok, "other's open fitment is in the fleet-wide list, proving this is fleet-wide and not one unit's")
	require.Equal(t, 0, otherRow.DaysFitted, "a fitment planted today is zero days fitted")

	require.NotContains(t, byFitment, fitmentB.String(), "tenant B's open fitment must never appear in tenant A's read")

	// open=true is required; its absence is refused before a transaction
	// opens rather than silently answering an unfiltered list.
	require.Equal(t, http.StatusBadRequest, get(t, h, "/api/fitments", tenantID.String(), controller.String()).Code)
}

type depotBody struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// GET /api/depots?type= narrows to the named app.depot_type, always active
// only, and refuses a value outside the enum before a transaction opens.
func TestDepotsFilterByType(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "depots")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	plantDepot := func(name, depotType string, active bool) {
		_, err := admin.Exec(ctx,
			`INSERT INTO app.depot (tenant_id, name, type, active) VALUES ($1, $2, $3::app.depot_type, $4)`,
			tenantID, name, depotType, active)
		require.NoError(t, err)
	}
	plantDepot("Retreader One", "RETREADER", true)
	plantDepot("Breakdown One", "BREAKDOWN_SUPPLIER", true)
	plantDepot("Retired Retreader", "RETREADER", false)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/depots?type=RETREADER", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var depots []depotBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &depots))
	require.Len(t, depots, 1, "the inactive RETREADER is excluded")
	require.Equal(t, "Retreader One", depots[0].Name)
	require.Equal(t, "RETREADER", depots[0].Type)

	require.Equal(t, http.StatusBadRequest,
		get(t, h, "/api/depots?type=NOT_A_TYPE", tenantID.String(), controller.String()).Code)
}

// A DRIVER holds CaptureInspection alone, never ViewFleet, so the unit read
// is refused before unitByID ever runs (FR-AUT-005's "what may be asked
// for", not only what comes back — the same shape TestFleetListIsCapabilityGated
// asserts for the fleet list).
func TestUnitReadIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, fleet := plantTenantWithVehicle(t, ctx, admin, "unit-gate")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet,
	).Scan(&vehicleID))

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := get(t, h, "/api/vehicles/"+vehicleID.String(), tenantID.String(), driver.String())
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// A unit with no positions, fitments, inspections or readings must not
// merely happen to look empty — a hasHistory implementation hardcoded true,
// or a Go nil slice left uninitialised, would pass every fitted-unit
// assertion above but not this one. plantTenantWithVehicle's own contract
// plants a configuration with no position rows at all, which is also the one
// shape that proves every list here marshals as [] and not null.
func TestGetUnitAnswersEmptyShapesForABareUnit(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, fleet := plantTenantWithVehicle(t, ctx, admin, "unit-bare")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet,
	).Scan(&vehicleID))

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := get(t, h, "/api/vehicles/"+vehicleID.String(), tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	raw := rec.Body.String()
	require.Contains(t, raw, `"positions":[]`, "no positions must marshal as [], not null")
	require.Contains(t, raw, `"tags":[]`, "no tags must marshal as [], not null")
	require.Contains(t, raw, `"removalReasons":[]`, "no removal_reasons config row must marshal as [], not null")

	var body unitBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.False(t, body.HasHistory, "no fitment, inspection or reading row exists for this unit")
	require.False(t, body.HasOdometer, "plantTenantWithVehicle leaves unit_kind NULL")
}
