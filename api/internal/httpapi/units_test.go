package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	Description       *string            `json:"description"`
	BodyType          *string            `json:"bodyType"`
	UnitDescriptor    *string            `json:"unitDescriptor"`
	HomeDepotID       *string            `json:"homeDepotId"`
	OperatingGroupID  *string            `json:"operatingGroupId"`
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

// plantOperatingGroup plants the grouping row a unit can be assigned to.
// Nothing but a name is needed: app.operating_group carries its own defaults
// for active and created_at (000012), and the edit under test names only its
// id.
func plantOperatingGroup(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) uuid.UUID {
	t.Helper()
	var groupID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.operating_group (tenant_id, name) VALUES ($1, $2) RETURNING id`,
		tenantID, "group-"+uuid.NewString()[:8],
	).Scan(&groupID))
	return groupID
}

// patchedUnit sends one edit and answers the unit body it came back with.
// The 200 is asserted here so every test below reads the unit read's own
// shape (D6) rather than discovering a refusal three assertions later.
func patchedUnit(t *testing.T, h http.Handler, vehicleID, tenant, user, body string) unitBody {
	t.Helper()
	rec := patch(t, h, "/api/vehicles/"+vehicleID, tenant, user, body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out unitBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

// D5: the descriptive edit is one parameterised UPDATE, and three separate
// PATCHes are what prove the three column shapes it carries. A single
// "everything at once" edit would pass against an implementation that wrote
// NULL into every column the caller did not name, and against one that could
// not clear a nullable id at all. The second PATCH names one field only, so
// the COALESCE is load-bearing; the third clears the depot with "", the only
// shape that distinguishes "unchanged" from "cleared" on the wire.
func TestPatchUnitEditsDescriptiveFields(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-fields")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	depotID, _ := plantDepotOfType(t, ctx, admin, tenantID, "DEPOT")
	// This PATCH is the only write surface for operating_group_id, and two
	// rules nowhere near it read the column: threshold_policy resolution and
	// schedule targeting (000012). An untested edit here is an untested input
	// to both.
	groupID := plantOperatingGroup(t, ctx, admin, tenantID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	written := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"registration":"CA 123-456","description":"Long haul horse","bodyType":"TAUTLINER",`+
			`"unitDescriptor":"Horse A","homeDepotId":"`+depotID.String()+`",`+
			`"operatingGroupId":"`+groupID.String()+`"}`)
	require.NotNil(t, written.Registration)
	require.Equal(t, "CA 123-456", *written.Registration)
	require.NotNil(t, written.Description)
	require.Equal(t, "Long haul horse", *written.Description)
	require.NotNil(t, written.BodyType)
	require.Equal(t, "TAUTLINER", *written.BodyType)
	require.NotNil(t, written.UnitDescriptor)
	require.Equal(t, "Horse A", *written.UnitDescriptor)
	require.NotNil(t, written.HomeDepotID)
	require.Equal(t, depotID.String(), *written.HomeDepotID)
	require.NotNil(t, written.OperatingGroupID)
	require.Equal(t, groupID.String(), *written.OperatingGroupID)
	require.Len(t, written.Positions, 3, "the PATCH answers with the unit read's own body")

	newFleet := "PATCHED-" + uuid.NewString()[:8]
	kept := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"fleetNumber":"`+newFleet+`"}`)
	require.Equal(t, newFleet, kept.FleetNumber)
	require.NotNil(t, kept.Description)
	require.Equal(t, "Long haul horse", *kept.Description, "an absent key leaves its column alone")
	require.NotNil(t, kept.BodyType)
	require.Equal(t, "TAUTLINER", *kept.BodyType)
	require.NotNil(t, kept.HomeDepotID)
	require.Equal(t, depotID.String(), *kept.HomeDepotID)
	require.NotNil(t, kept.OperatingGroupID)
	require.Equal(t, groupID.String(), *kept.OperatingGroupID)

	cleared := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"homeDepotId":"","operatingGroupId":""}`)
	require.Nil(t, cleared.HomeDepotID, "an empty string clears a nullable id")
	require.Nil(t, cleared.OperatingGroupID)
	require.NotNil(t, cleared.Description)
	require.Equal(t, "Long haul horse", *cleared.Description, "clearing one field changes no other")
	require.Equal(t, newFleet, cleared.FleetNumber)

	// D5 gives the text columns no clear at all, so a blank one reads as
	// absence: the column keeps what it holds rather than emptying.
	blankText := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"description":""}`)
	require.NotNil(t, blankText.Description)
	require.Equal(t, "Long haul horse", *blankText.Description,
		"a text column is edited through this surface, never cleared")

	// Another fleet's operating group is not an id this unit may hold, and
	// the composite FK (000012) is the only thing that says so: it reaches Go
	// as 23503 and comes back canned, never naming the constraint.
	tenantB, _ := plantTenant(t, ctx, admin, "patch-fields-b")
	groupB := plantOperatingGroup(t, ctx, admin, tenantB)
	crossTenant := patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String(),
		`{"operatingGroupId":"`+groupB.String()+`"}`)
	require.Equal(t, http.StatusUnprocessableEntity, crossTenant.Code, crossTenant.Body.String())
	var crossRef refusalBody
	require.NoError(t, json.Unmarshal(crossTenant.Body.Bytes(), &crossRef))
	require.Equal(t, "invalid_submission", crossRef.Code)
	var groupAfter *uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT operating_group_id FROM app.vehicle WHERE id = $1`, mine).Scan(&groupAfter))
	require.Nil(t, groupAfter, "a refused edit leaves the column as it stood")

	// A TECHNICIAN holds ViewFleet alone (auth.go), so it reads this unit and
	// may not edit it — the capability gate, not the route, is what refuses.
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	require.Equal(t, http.StatusOK,
		get(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), technician.String()).Code)
	require.Equal(t, http.StatusForbidden,
		patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), technician.String(),
			`{"description":"a technician may not edit this"}`).Code)
}

// D5: configuration_id and unit_kind are not fields of this request, in any
// spelling, and the decoder is what says so — before a transaction opens, so
// TY008 (000028's trigger) stays a pure database backstop no endpoint can
// reach (docs/implementation-order.md §B5). Each refusal names the key the
// caller sent, because "invalid_submission" alone leaves a form with nothing
// to point at.
func TestPatchUnitRefusesConfigurationID(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-refuses")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var configBefore uuid.UUID
	var kindBefore string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT configuration_id, unit_kind::text FROM app.vehicle WHERE id = $1`, mine,
	).Scan(&configBefore, &kindBefore))

	for _, tc := range []struct{ key, value string }{
		{"configurationId", uuid.NewString()},
		{"unitKind", "TRAILER"},
		{"configuration_id", uuid.NewString()},
		{"unit_kind", "TRAILER"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			rec := patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String(),
				`{"`+tc.key+`":"`+tc.value+`"}`)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Contains(t, ref.Message, tc.key, "the refusal names the field the caller sent")
			require.NotContains(t, ref.Message, "app.vehicle",
				"a decoder refusal names no schema object (ADR-0012)")
		})
	}

	var configAfter uuid.UUID
	var kindAfter string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT configuration_id, unit_kind::text FROM app.vehicle WHERE id = $1`, mine,
	).Scan(&configAfter, &kindAfter))
	require.Equal(t, configBefore, configAfter, "a refused PATCH moves no configuration")
	require.Equal(t, kindBefore, kindAfter)

	// The bodies this decoder refuses for their shape rather than their keys.
	// A body this surface cannot read is malformed rather than invalid, because
	// nothing in it is a field the caller got wrong. Why each of these needs a
	// second Decode rather than dec.More() is decodeJSONStrict's own note
	// (admin.go).
	for _, tc := range []struct{ name, body string }{
		{"a second value after the first", `{"description":"first"}{"configurationId":"smuggled"}`},
		{"a literal null", `null`},
		{"a trailing closing brace", `{"description":"x"}}`},
		{"a trailing closing bracket", `{"description":"x"}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String(), tc.body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "malformed_json", ref.Code)
		})
	}
	var description *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT description FROM app.vehicle WHERE id = $1`, mine).Scan(&description))
	require.Nil(t, description, "a malformed body lands none of the values it did parse")

	// The control: the same route, the same actor, a field that IS of this
	// request. Without it every refusal above would also pass against a route
	// that refused everything. The trailing newline and spaces are part of the
	// control — whitespace after the value is what a body that ended cleanly
	// looks like, and a trailing-token check that refused it would refuse
	// every pretty-printed request a client sends.
	edited := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		"{\"description\":\"still editable\"}  \n")
	require.NotNil(t, edited.Description)
	require.Equal(t, "still editable", *edited.Description)
}

// FR-VEH-041/U6: tags replace, they do not merge. The three edits are set,
// narrow and clear, each read back — a merging implementation passes the
// first and fails the second, and one that ignored an empty array passes
// both and fails the third. The tag NAME survives a clear (000035 restores
// DELETE on the map alone, never on app.vehicle_tag), which the second unit
// still carrying it is what proves.
func TestPatchUnitReplacesTags(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-tags")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	countTag := func(name string) int {
		var n int
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT count(*) FROM app.vehicle_tag WHERE tenant_id = $1 AND name = $2`, tenantID, name,
		).Scan(&n))
		return n
	}

	set := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"tags":["LONG HAUL","REEFER"]}`)
	require.ElementsMatch(t, []string{"LONG HAUL", "REEFER"}, set.Tags)

	// The second unit takes one of the same names: a tag row is created once
	// per tenant and shared, so this is also the upsert's ON CONFLICT branch.
	shared := patchedUnit(t, h, other.String(), tenantID.String(), controller.String(),
		`{"tags":["REEFER"]}`)
	require.Equal(t, []string{"REEFER"}, shared.Tags)
	require.Equal(t, 1, countTag("REEFER"), "a tag name is created once per tenant, not once per unit")

	narrowed := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"tags":["REEFER"]}`)
	require.Equal(t, []string{"REEFER"}, narrowed.Tags, "the set is replaced, not merged")

	// A blank name is not a tag, and the refusal leaves the set as it stood.
	// The good name in the refused body is deliberately one the unit does NOT
	// carry: a handler that applied the names it could read before refusing
	// the one it could not would leave "LONG HAUL" behind, which the read-back
	// would catch and a body of ["REEFER","  "] could not.
	blank := patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String(),
		`{"tags":["LONG HAUL","  "]}`)
	require.Equal(t, http.StatusUnprocessableEntity, blank.Code, blank.Body.String())
	var blankRef refusalBody
	require.NoError(t, json.Unmarshal(blank.Body.Bytes(), &blankRef))
	require.Equal(t, "invalid_submission", blankRef.Code)
	require.Contains(t, blankRef.Message, "tags")

	afterBlank := get(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, afterBlank.Code, afterBlank.Body.String())
	var afterBlankBody unitBody
	require.NoError(t, json.Unmarshal(afterBlank.Body.Bytes(), &afterBlankBody))
	require.Equal(t, []string{"REEFER"}, afterBlankBody.Tags, "a refused edit changes no tag")

	// A repeated name is one tag. Without the de-duplication the second map
	// insert would meet the map primary key and answer 409, so this asserts
	// how the handler reads the request rather than what the constraint does.
	deduped := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"tags":["REEFER","REEFER"]}`)
	require.Equal(t, []string{"REEFER"}, deduped.Tags)

	// An absent key is not an empty set.
	untouched := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"description":"tags untouched"}`)
	require.Equal(t, []string{"REEFER"}, untouched.Tags)

	emptied := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"tags":[]}`)
	require.Empty(t, emptied.Tags, "an empty array clears the set")

	stillTagged := get(t, h, "/api/vehicles/"+other.String(), tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, stillTagged.Code, stillTagged.Body.String())
	var otherBody unitBody
	require.NoError(t, json.Unmarshal(stillTagged.Body.Bytes(), &otherBody))
	require.Equal(t, []string{"REEFER"}, otherBody.Tags,
		"one unit's clear must not strip the name from another unit")
	require.Equal(t, 1, countTag("REEFER"), "the tag name itself is never deleted by an edit")
}

// The transport cap on how many tags one edit may name (maxTagsPerPatch). The
// pair is the boundary itself: fifty is accepted and read back whole, so the
// cap cannot be met by a handler that simply truncates, and fifty-one is
// refused naming the number, so a caller can act on the message.
func TestPatchUnitCapsTagCount(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-tagcap")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	names := func(n int) string {
		out := make([]string, 0, n)
		for i := range n {
			out = append(out, fmt.Sprintf("TAG-%02d", i))
		}
		encoded, err := json.Marshal(map[string][]string{"tags": out})
		require.NoError(t, err)
		return string(encoded)
	}

	atCap := patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(), names(50))
	require.Len(t, atCap.Tags, 50, "the cap is inclusive; fifty tags land whole")

	over := patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String(), names(51))
	require.Equal(t, http.StatusUnprocessableEntity, over.Code, over.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(over.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "50", "the refusal names the cap it enforced")
	require.Contains(t, ref.Message, "tags")

	// The refusal is validation, so it precedes the transaction: the set the
	// accepted edit left is still the one the unit carries.
	after := get(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, after.Code, after.Body.String())
	var afterBody unitBody
	require.NoError(t, json.Unmarshal(after.Body.Bytes(), &afterBody))
	require.Len(t, afterBody.Tags, 50)
}

// DR-003's uniqueness is the constraint's alone: the PATCH carries no
// pre-check, so vehicle_tenant_id_fleet_number_key is what refuses this and
// conflictCodes is what names it for the caller. This is the one test on the
// surface that reaches a conflictCodes entry in anger rather than only
// asserting the key names a live schema object.
func TestPatchUnitFleetNumberConflictIs409(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-conflict")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var taken, mineBefore string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT fleet_number FROM app.vehicle WHERE id = $1`, other).Scan(&taken))
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT fleet_number FROM app.vehicle WHERE id = $1`, mine).Scan(&mineBefore))

	rec := patch(t, h, "/api/vehicles/"+mine.String(), tenantID.String(), controller.String(),
		`{"fleetNumber":"`+taken+`","description":"landed anyway?"}`)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "fleet_number_taken", ref.Code)

	var mineAfter string
	var description *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT fleet_number, description FROM app.vehicle WHERE id = $1`, mine,
	).Scan(&mineAfter, &description))
	require.Equal(t, mineBefore, mineAfter)
	require.Nil(t, description, "a refused edit lands none of its fields")

	// Another tenant may hold the same fleet number: the constraint is
	// per-tenant, so the refusal above is DR-003's and not a global
	// uniqueness this surface invented.
	tenantB, mineB, _, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-conflict-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	require.Equal(t, taken,
		patchedUnit(t, h, mineB.String(), tenantB.String(), controllerB.String(),
			`{"fleetNumber":"`+taken+`"}`).FleetNumber)
}

// FR-AUD-001: the edit is audited by 000035's vehicle_audited trigger, which
// is why the handler carries no audit code at all — an implementation that
// wrote its own row would fail the "exactly one" count. action is filtered to
// UPDATE because the fixture's own INSERT already wrote a row for this unit
// with a NULL actor (the trigger fires on both).
func TestPatchUnitAuditsTheChange(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, _, _, _ := plantUnitFixture(t, ctx, admin, "patch-audit")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	countUpdates := func() int {
		var n int
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT count(*) FROM app.audit_log
			  WHERE entity_type = 'vehicle' AND entity_id = $1 AND action = 'UPDATE'`, mine,
		).Scan(&n))
		return n
	}
	require.Zero(t, countUpdates(), "no edit has happened yet")

	patchedUnit(t, h, mine.String(), tenantID.String(), controller.String(),
		`{"description":"audited edit"}`)
	require.Equal(t, 1, countUpdates(), "one edit writes exactly one audit row")

	var actorID, tenantOnRow uuid.UUID
	var afterDescription string
	var beforeDescription *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT actor_id, tenant_id, after->>'description', before->>'description'
		   FROM app.audit_log
		  WHERE entity_type = 'vehicle' AND entity_id = $1 AND action = 'UPDATE'
		  ORDER BY at DESC, id DESC LIMIT 1`, mine,
	).Scan(&actorID, &tenantOnRow, &afterDescription, &beforeDescription))
	require.Equal(t, controller, actorID, "the acting user is the one the actor transaction bound")
	require.Equal(t, tenantID, tenantOnRow)
	require.Equal(t, "audited edit", afterDescription)
	require.Nil(t, beforeDescription, "the row before the edit carried no description")
}

// The WITH CHECK kill for the tag map, the shape admin_test.go's
// TestWriteAimedAtAnotherTenantIsRefused established. Every id is tenant B's
// own — its unit and its tag — so a composite FK (000012) cannot be what
// refuses this row: the one thing wrong with it is that tenant A is writing
// it (lesson 2026-08-28). app.vehicle_tag_map has no created_by column, so
// that lesson's FK trap has no counterpart to fall into here.
func TestWriteAimedAtAnotherTenantIsRefused_VehicleTag(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _, _, _, _, _ := plantUnitFixture(t, ctx, admin, "tagmap-withcheck-a")
	tenantB, mineB, _, _, _, _ := plantUnitFixture(t, ctx, admin, "tagmap-withcheck-b")
	userA := plantUser(t, ctx, admin, tenantA, auth.RoleController)

	var tagB uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle_tag (tenant_id, name) VALUES ($1, $2) RETURNING id`,
		tenantB, "SMUGGLED-"+uuid.NewString()[:8],
	).Scan(&tagB))

	err := s.InActorTx(ctx, tenantA, userA, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id) VALUES ($1, $2, $3)`,
			tenantB, mineB, tagB)
		return err
	})
	require.Error(t, err, "a tag map row aimed at another tenant was accepted")

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	// 42501 is insufficient_privilege, which is how row-level security
	// refuses a write it will not admit.
	require.Equal(t, "42501", pgErr.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.vehicle_tag_map WHERE tag_id = $1`, tagB).Scan(&landed))
	require.Zero(t, landed)
}

// FR-VEH-005/FR-VEH-006 and INV-2, end to end over app.set_vehicle_status.
//
// The parked half deliberately does NOT assert "the driver's task list stops
// showing the unit": app.generate_inspection_tasks skips any unit already
// holding an OPEN or ESCALATED task whatever its status, so a second generate
// creates nothing for either unit and that assertion would pass with the
// v.status = 'ACTIVE' filter deleted. What is asserted instead is generation
// itself, with a control — both units are scheduled and both generate a task;
// the tasks are then cancelled and one unit parked; a later generate, later
// than the interval so the due-date window is not what answers, issues a task
// for the ACTIVE unit and none for the PARKED one. The driver's own
// /api/my/tasks read is what reads that difference back.
func TestSetUnitStatusParksAndDisposes(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "unit-status")
	plantRemovalReasons(t, ctx, admin, tenantID, "WORN")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, mine, driver)
	assignVehicleDriver(t, ctx, admin, tenantID, other, driver)
	// interval_days 1, not the table's default 7: the generator also skips a
	// unit whose newest task is due within one interval of the as-of date, so
	// a short interval is what leaves the status filter as the only thing
	// that can answer the second generate below.
	for _, vehicleID := range []uuid.UUID{mine, other} {
		_, err := admin.Exec(ctx,
			`INSERT INTO app.inspection_schedule (tenant_id, vehicle_id, interval_days, active)
			 VALUES ($1, $2, 1, true)`, tenantID, vehicleID)
		require.NoError(t, err)
	}
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// Generation runs inside an actor transaction, never on the admin
	// connection: the function is invoker-rights and RLS is what scopes it to
	// one tenant, so a superuser session would issue tasks for every tenant
	// in the database.
	generate := func(offsetDays int) int {
		t.Helper()
		var n int
		require.NoError(t, s.InActorTx(ctx, tenantID, controller, func(tx pgx.Tx, _ auth.Actor) error {
			return tx.QueryRow(ctx,
				`SELECT app.generate_inspection_tasks(current_date + $1::int)`, offsetDays).Scan(&n)
		}))
		return n
	}
	myTaskVehicles := func() []string {
		t.Helper()
		rec := get(t, h, "/api/my/tasks", tenantID.String(), driver.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var tasks []struct {
			VehicleID string `json:"vehicleId"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &tasks))
		out := []string{}
		for _, task := range tasks {
			out = append(out, task.VehicleID)
		}
		return out
	}

	require.Equal(t, 2, generate(0), "both units are ACTIVE and scheduled")
	require.ElementsMatch(t, []string{mine.String(), other.String()}, myTaskVehicles())

	parked := post(t, h, "/api/vehicles/"+mine.String()+"/status", tenantID.String(), controller.String(),
		`{"status":"PARKED"}`)
	require.Equal(t, http.StatusNoContent, parked.Code, parked.Body.String())

	_, err := admin.Exec(ctx,
		`UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = 'fixture reset'
		  WHERE tenant_id = $1`, tenantID)
	require.NoError(t, err)
	require.Empty(t, myTaskVehicles(), "the planted tasks are out of the way")

	require.Equal(t, 1, generate(3), "the parked unit is skipped; the ACTIVE one is not")
	require.Equal(t, []string{other.String()}, myTaskVehicles(),
		"FR-VEH-006: a parked unit stops being issued tasks, and only that unit does")

	refused := func(vehicleID uuid.UUID, body string) refusalBody {
		t.Helper()
		rec := post(t, h, "/api/vehicles/"+vehicleID.String()+"/status",
			tenantID.String(), controller.String(), body)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
		var ref refusalBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
		require.Equal(t, "TY016", ref.Code)
		return ref
	}

	require.Contains(t, refused(mine, `{"status":"PARKED"}`).Message, "already PARKED",
		"a no-op transition would put a row in the audit log claiming a change that did not happen")

	// Shape, and only shape (ADR-0013 decision 5): a status outside the enum
	// reaches the ::app.vehicle_status cast as 22P02 and comes back canned,
	// and a status the request never names is refused before the transaction
	// opens. Neither is a rule about units, so app.vehicle_status gets no
	// second copy in Go to drift from the enum.
	for _, tc := range []struct{ name, body, code, message string }{
		{"a status outside the enum", `{"status":"SIDEWAYS"}`, "invalid_submission",
			"the submission was refused as invalid"},
		{"a blank status", `{"status":""}`, "invalid_submission", "status is required"},
		{"no status at all", `{}`, "invalid_submission", "status is required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, h, "/api/vehicles/"+mine.String()+"/status",
				tenantID.String(), controller.String(), tc.body)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, tc.code, ref.Code)
			require.Equal(t, tc.message, ref.Message)
		})
	}
	var parkedStill string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT status::text FROM app.vehicle WHERE id = $1`, mine).Scan(&parkedStill))
	require.Equal(t, "PARKED", parkedStill, "a refused shape moves no status")

	// INV-2: a unit leaves the fleet empty. other is a TRAILER, so no fitted
	// odometer is required (000025) and the only thing standing between it
	// and disposal is the casing on it.
	tyreID := plantTyre(t, ctx, admin, tenantID, "STATUS-TYRE-"+uuid.NewString()[:8], nil)
	fitmentID := fitTyreViaActor(t, ctx, s, tenantID, controller, tyreID, other, leftPos, "9.0", "MARK_OUTBOARD", nil)
	require.Contains(t, refused(other, `{"status":"DISPOSED","reason":"sold at auction"}`).Message,
		"still has fitted tyres")

	var statusNow string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT status::text FROM app.vehicle WHERE id = $1`, other).Scan(&statusNow))
	require.Equal(t, "ACTIVE", statusNow, "a refused transition moves nothing")

	removeTyreViaActor(t, ctx, s, tenantID, controller, fitmentID, "WORN", "4.0", nil)
	require.Contains(t, refused(other, `{"status":"DISPOSED"}`).Message, "records the reason",
		"a disposal states why the unit left the fleet")

	disposed := post(t, h, "/api/vehicles/"+other.String()+"/status", tenantID.String(), controller.String(),
		`{"status":"DISPOSED","reason":"sold at auction"}`)
	require.Equal(t, http.StatusNoContent, disposed.Code, disposed.Body.String())

	require.Contains(t, refused(other, `{"status":"ACTIVE"}`).Message, "that is where a unit",
		"DISPOSED is terminal (FR-VEH-005)")

	// A DRIVER holds CaptureInspection alone: it captures on the unit and
	// does not decide what state the unit is in.
	require.Equal(t, http.StatusForbidden,
		post(t, h, "/api/vehicles/"+mine.String()+"/status", tenantID.String(), driver.String(),
			`{"status":"ACTIVE"}`).Code)
}

// The handler-level invisibility probe. Tenant A's unit is ACTIVE and the
// target is PARKED, so a leak would let this call SUCCEED outright rather
// than meet a second refusal sharing TY016's SQLSTATE (lesson 2026-09-01) —
// and tenant A performing the identical transition afterwards is what proves
// the move itself was legal.
func TestUnitStatusCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, mineA, _, _, _, _ := plantUnitFixture(t, ctx, admin, "status-xten-a")
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	tenantB, _, _, _, _, _ := plantUnitFixture(t, ctx, admin, "status-xten-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+mineA.String()+"/status", tenantB.String(), controllerB.String(),
		`{"status":"PARKED"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
		"tenant B reached tenant A's unit: RLS leaked it (got %s)", rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such unit in this fleet", ref.Message)

	var statusNow string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT status::text FROM app.vehicle WHERE id = $1`, mineA).Scan(&statusNow))
	require.Equal(t, "ACTIVE", statusNow)

	own := post(t, h, "/api/vehicles/"+mineA.String()+"/status", tenantA.String(), controllerA.String(),
		`{"status":"PARKED"}`)
	require.Equal(t, http.StatusNoContent, own.Code, own.Body.String())
}
