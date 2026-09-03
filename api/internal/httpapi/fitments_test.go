package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type fitWarningBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type fitmentCreatedBody struct {
	FitmentID string           `json:"fitmentId"`
	Warnings  []fitWarningBody `json:"warnings"`
}

type rotationCreatedBody struct {
	Moves []struct {
		TyreID    string `json:"tyreId"`
		FitmentID string `json:"fitmentId"`
	} `json:"moves"`
}

// plantRetreadTyre is plantTyre for a casing that has been round once. The
// pair (status, retread_count) is what retread_count_matches_status (000001)
// admits, and app.fit_tyre's FR-FIT-006 branch reads the status alone.
func plantRetreadTyre(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, code string) uuid.UUID {
	t.Helper()
	var tyreID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.tyre (tenant_id, display_code, new_tread_mm, rand_per_mm, status, retread_count)
		 VALUES ($1, $2, 14.0, 250.0000, 'RETREAD'::app.tyre_status, 1) RETURNING id`,
		tenantID, code,
	).Scan(&tyreID))
	return tyreID
}

// plantRetreadPolicy plants FR-CFG-044's per-class rule. effective_from is
// backdated because app.fit_tyre only considers rows already effective, and
// a row stamped by its own DEFAULT now() in an earlier statement is not
// reliably earlier than the now() the fit reads.
func plantRetreadPolicy(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, axleClass string, permitted bool) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.threshold_policy (tenant_id, axle_class, retreads_permitted, effective_from)
		 VALUES ($1, $2::app.axle_class, $3, now() - interval '1 hour')`,
		tenantID, axleClass, permitted)
	require.NoError(t, err)
}

// fitBody is the request every fit test sends, so a field name changing on
// the wire breaks in one place rather than in every test that fits.
func fitBody(tyreID, positionID uuid.UUID, treadMm string, odometer *int64) string {
	odo := "null"
	if odometer != nil {
		odo = fmt.Sprintf("%d", *odometer)
	}
	return fmt.Sprintf(
		`{"tyreId":%q,"positionId":%q,"treadMm":%q,"mountOrientation":"MARK_OUTBOARD","odometer":%s}`,
		tyreID, positionID, treadMm, odo)
}

// fitmentAt answers the fitment the unit read shows at one position code, or
// nil for an empty position — the client-visible proof that a write landed
// on the unit it named. Position ids repeat across units of one axle
// configuration (lesson 2026-08-26), so "the fit landed" is only ever an
// assertion about a named unit's own read.
func fitmentAt(t *testing.T, h http.Handler, vehicleID, tenantID, userID, positionCode string) *unitPositionBody {
	t.Helper()
	rec := get(t, h, "/api/vehicles/"+vehicleID, tenantID, userID)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body unitBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	for i := range body.Positions {
		if body.Positions[i].Code == positionCode {
			return &body.Positions[i]
		}
	}
	t.Fatalf("no position %s on unit %s", positionCode, vehicleID)
	return nil
}

// The fit answers 201 with the id it minted and an empty warning list, and
// the unit read then shows the casing where it was put. "other" is a TRAILER
// so no odometer is the realistic shape (000025 exempts one) rather than a
// value this test has to invent; "mine" shares the configuration and so the
// identical position id, and its 1L must stay empty — a query keyed on the
// position alone would show the fit on both units.
func TestFitTyreHappyPath(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, other, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "fit-happy")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	tyreID := plantTyre(t, ctx, admin, tenantID, "FIT-HAPPY-"+uuid.NewString()[:8], nil)

	// occurredAt is sent explicitly here, the one place it is: it is the
	// field a workshop uses to record this morning's fit at lunchtime, it
	// reaches app.fit_tyre as a timestamptz through COALESCE, and no other
	// test would notice it never arriving. An hour back is inside
	// FR-FIT-016's 24-hour window, so no justification is required with it.
	occurredAt := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/vehicles/"+other.String()+"/fitments", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"tyreId":%q,"positionId":%q,"treadMm":"9.5","mountOrientation":"MARK_OUTBOARD","occurredAt":%q}`,
			tyreID, leftPos, occurredAt))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"warnings":[]`, "no warnings must marshal as [], not null")

	var created fitmentCreatedBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	_, err := uuid.Parse(created.FitmentID)
	require.NoError(t, err, "the response carries the fitment id it minted")
	require.Empty(t, created.Warnings)

	fitted := fitmentAt(t, h, other.String(), tenantID.String(), controller.String(), "1L")
	require.NotNil(t, fitted.Fitment, "the unit read shows the casing that was just fitted")
	require.Equal(t, tyreID.String(), fitted.Fitment.TyreID)
	require.Equal(t, created.FitmentID, fitted.Fitment.FitmentID)
	require.Equal(t, "MARK_OUTBOARD", fitted.Fitment.MountOrientation)

	fittedAt, err := time.Parse(time.RFC3339, fitted.Fitment.FittedAt)
	require.NoError(t, err)
	require.WithinDuration(t, time.Now().Add(-time.Hour), fittedAt, time.Minute,
		"the fit was recorded at the instant the request named, not at now()")

	elsewhere := fitmentAt(t, h, mine.String(), tenantID.String(), controller.String(), "1L")
	require.Nil(t, elsewhere.Fitment, "the same position id on the other unit stays empty")
}

// ADR-0012's TY009 deferral discharged: the trigger in 000025 fires through
// app.fit_tyre on a unit that has an odometer, and submitStatus is what turns
// it into a 422 the client can act on rather than a 500 the outbox retries
// for ever. Removing the TY009 entry from submitStatus must fail this test.
func TestFitOnHorseWithoutOdometerIsTY009(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "fit-ty009")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	tyreID := plantTyre(t, ctx, admin, tenantID, "FIT-TY009-"+uuid.NewString()[:8], nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/vehicles/"+mine.String()+"/fitments", tenantID.String(), controller.String(),
		fitBody(tyreID, leftPos, "9.5", nil))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())

	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY009", ref.Code)
	require.Equal(t, "fitment odometer is required for a unit that has one", ref.Message)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.fitment WHERE tyre_id = $1`, tyreID).Scan(&landed))
	require.Zero(t, landed, "a refused fit leaves no fitment behind")
}

// Occupancy is one_open_fitment_per_position's alone (000001) — app.fit_tyre
// deliberately carries no pre-check, so the raw 23505 reaches Go and
// conflictCodes is what names it for a caller. Both tyres are IN_STOCK, so
// the second fit passes every check the function does make and can only be
// refused by the index.
func TestFitOnOccupiedPositionIs409PositionOccupied(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _, other, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "fit-occupied")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	suffix := uuid.NewString()[:8]
	first := plantTyre(t, ctx, admin, tenantID, "FIT-OCC-A-"+suffix, nil)
	second := plantTyre(t, ctx, admin, tenantID, "FIT-OCC-B-"+suffix, nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/vehicles/" + other.String() + "/fitments"
	require.Equal(t, http.StatusCreated,
		post(t, h, path, tenantID.String(), controller.String(), fitBody(first, leftPos, "9.5", nil)).Code)

	rec := post(t, h, path, tenantID.String(), controller.String(), fitBody(second, leftPos, "9.0", nil))
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "position_occupied", ref.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.fitment WHERE tyre_id = $1`, second).Scan(&landed))
	require.Zero(t, landed, "the refused fit opened no second row on the position")
}

// FR-FIT-006/U11: the platform reports the tenant's configured policy, it
// does not decide what may be fitted. The warning reaches the wire AND the
// fitment lands — a handler that turned a warning into a refusal would pass
// the first assertion and fail the last.
func TestFitReturnsWarningsWithoutBlocking(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "fit-warning")
	plantRetreadPolicy(t, ctx, admin, tenantID, "STEER", false)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	tyreID := plantRetreadTyre(t, ctx, admin, tenantID, "FIT-WARN-"+uuid.NewString()[:8])

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/vehicles/"+mine.String()+"/fitments", tenantID.String(), controller.String(),
		fitBody(tyreID, leftPos, "9.5", int64Ptr(50000)))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var created fitmentCreatedBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Len(t, created.Warnings, 1)
	require.Equal(t, "RETREAD_ON_NON_PERMITTED_AXLE", created.Warnings[0].Code)
	require.NotEmpty(t, created.Warnings[0].Message)

	fitted := fitmentAt(t, h, mine.String(), tenantID.String(), controller.String(), "1L")
	require.NotNil(t, fitted.Fitment, "a warning is advice; the casing is on the unit")
	require.Equal(t, tyreID.String(), fitted.Fitment.TyreID)
}

// FR-FIT-009/CR-012: a removal that carries both odometers records the
// distance AND the provenance it was derived under, read back through the
// history the manager actually sees.
func TestRemoveFitmentWritesProvenance(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "remove-provenance")
	plantRemovalReasons(t, ctx, admin, tenantID, "WORN", "DAMAGED")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	tyreID := plantTyre(t, ctx, admin, tenantID, "REM-PROV-"+uuid.NewString()[:8], nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	fitRec := post(t, h, "/api/vehicles/"+mine.String()+"/fitments", tenantID.String(), controller.String(),
		fitBody(tyreID, leftPos, "10.0", int64Ptr(10000)))
	require.Equal(t, http.StatusCreated, fitRec.Code, fitRec.Body.String())
	var created fitmentCreatedBody
	require.NoError(t, json.Unmarshal(fitRec.Body.Bytes(), &created))

	rec := post(t, h, "/api/fitments/"+created.FitmentID+"/remove", tenantID.String(), controller.String(),
		`{"reason":"WORN","treadMm":"4.0","odometer":10500}`)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	histRec := get(t, h, "/api/vehicles/"+mine.String()+"/fitments", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, histRec.Code, histRec.Body.String())
	var rows []fitmentHistoryBody
	require.NoError(t, json.Unmarshal(histRec.Body.Bytes(), &rows))
	require.Len(t, rows, 1)
	require.Equal(t, created.FitmentID, rows[0].FitmentID)
	require.NotNil(t, rows[0].RemovedAt)
	require.NotNil(t, rows[0].RemovalReason)
	require.Equal(t, "WORN", *rows[0].RemovalReason)
	require.Equal(t, "MEASURED", rows[0].DistanceSource)
	require.NotNil(t, rows[0].DistanceKm)
	require.Equal(t, int64(500), *rows[0].DistanceKm)

	require.Nil(t, fitmentAt(t, h, mine.String(), tenantID.String(), controller.String(), "1L").Fitment,
		"the position is empty once the fitment is closed")
}

// FR-FIT-010/FR-FIT-014: a rotation is one set of moves or none of them.
// The valid swap runs first, so the 201 shape the unit screen's rotation form
// consumes is exercised and the "unchanged" assertion afterwards has a
// non-trivial state to be unchanged from — a rotation asserted only against a
// fresh unit would pass an implementation that silently wrote nothing at all.
func TestRotateIsAtomic(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _, other, leftPos, rightPos, _ := plantUnitFixture(t, ctx, admin, "rotate-atomic")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	suffix := uuid.NewString()[:8]
	leftTyre := plantTyre(t, ctx, admin, tenantID, "ROT-L-"+suffix, nil)
	rightTyre := plantTyre(t, ctx, admin, tenantID, "ROT-R-"+suffix, nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	fitPath := "/api/vehicles/" + other.String() + "/fitments"
	require.Equal(t, http.StatusCreated,
		post(t, h, fitPath, tenantID.String(), controller.String(), fitBody(leftTyre, leftPos, "9.0", nil)).Code)
	require.Equal(t, http.StatusCreated,
		post(t, h, fitPath, tenantID.String(), controller.String(), fitBody(rightTyre, rightPos, "8.0", nil)).Code)

	rotatePath := "/api/vehicles/" + other.String() + "/rotations"
	swap := fmt.Sprintf(`{"moves":[{"tyreId":%q,"toPositionId":%q,"treadMm":"8.5"},
	                              {"tyreId":%q,"toPositionId":%q,"treadMm":"7.5"}]}`,
		leftTyre, rightPos, rightTyre, leftPos)
	rec := post(t, h, rotatePath, tenantID.String(), controller.String(), swap)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var rotated rotationCreatedBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rotated))
	require.Len(t, rotated.Moves, 2)
	byTyre := map[string]string{}
	for _, m := range rotated.Moves {
		_, err := uuid.Parse(m.FitmentID)
		require.NoError(t, err, "every move answers the fitment it opened")
		byTyre[m.TyreID] = m.FitmentID
	}
	require.Contains(t, byTyre, leftTyre.String())
	require.Contains(t, byTyre, rightTyre.String())

	// The second move's tread is outside the range every move records in, so
	// the set is refused — TY014, and the wire code has to be mapped for it
	// to arrive as anything but a 500.
	bad := fmt.Sprintf(`{"moves":[{"tyreId":%q,"toPositionId":%q,"treadMm":"8.0"},
	                             {"tyreId":%q,"toPositionId":%q,"treadMm":"0"}]}`,
		leftTyre, leftPos, rightTyre, rightPos)
	badRec := post(t, h, rotatePath, tenantID.String(), controller.String(), bad)
	require.Equal(t, http.StatusUnprocessableEntity, badRec.Code, badRec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(badRec.Body.Bytes(), &ref))
	require.Equal(t, "TY014", ref.Code)

	// An empty set is refused by the function, not by Go: the length rule is
	// TY014's and this pins that no second copy of it grew here (ADR-0013 d.5).
	emptyRec := post(t, h, rotatePath, tenantID.String(), controller.String(), `{"moves":[]}`)
	require.Equal(t, http.StatusUnprocessableEntity, emptyRec.Code, emptyRec.Body.String())
	var emptyRef refusalBody
	require.NoError(t, json.Unmarshal(emptyRec.Body.Bytes(), &emptyRef))
	require.Equal(t, "TY014", emptyRef.Code)
	require.Equal(t, "a rotation is two or more moves", emptyRef.Message)

	// Not merely "unchanged from the start": the unit still shows the state
	// the valid swap left it in, down to the fitment ids — a refused set that
	// had closed and reopened one row would carry the right tyres on new
	// fitments and pass a tyre-id-only assertion.
	left := fitmentAt(t, h, other.String(), tenantID.String(), controller.String(), "1L")
	right := fitmentAt(t, h, other.String(), tenantID.String(), controller.String(), "1R")
	require.NotNil(t, left.Fitment)
	require.NotNil(t, right.Fitment)
	require.Equal(t, rightTyre.String(), left.Fitment.TyreID, "the refused rotation moved nothing")
	require.Equal(t, leftTyre.String(), right.Fitment.TyreID, "the refused rotation moved nothing")
	require.Equal(t, byTyre[rightTyre.String()], left.Fitment.FitmentID, "no fitment was closed and reopened")
	require.Equal(t, byTyre[leftTyre.String()], right.Fitment.FitmentID, "no fitment was closed and reopened")
}

// D6: every fitment write is ManageAssets, which a TECHNICIAN does not hold
// (it holds ViewFleet alone). Each body is well-formed so the refusal is
// provably the capability gate and not Go's shape validation, which runs
// before the transaction opens.
func TestFitmentWritesAreCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _, other, leftPos, rightPos, _ := plantUnitFixture(t, ctx, admin, "fitment-gate")
	plantRemovalReasons(t, ctx, admin, tenantID, "WORN")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	suffix := uuid.NewString()[:8]
	fitted := plantTyre(t, ctx, admin, tenantID, "GATE-FITTED-"+suffix, nil)
	spare := plantTyre(t, ctx, admin, tenantID, "GATE-SPARE-"+suffix, nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	fitRec := post(t, h, "/api/vehicles/"+other.String()+"/fitments", tenantID.String(), controller.String(),
		fitBody(fitted, leftPos, "9.0", nil))
	require.Equal(t, http.StatusCreated, fitRec.Code, fitRec.Body.String())
	var created fitmentCreatedBody
	require.NoError(t, json.Unmarshal(fitRec.Body.Bytes(), &created))

	for _, tt := range []struct{ name, path, body string }{
		{"fit", "/api/vehicles/" + other.String() + "/fitments", fitBody(spare, rightPos, "9.0", nil)},
		{"remove", "/api/fitments/" + created.FitmentID + "/remove", `{"reason":"WORN","treadMm":"4.0"}`},
		{"rotate", "/api/vehicles/" + other.String() + "/rotations", fmt.Sprintf(
			`{"moves":[{"tyreId":%q,"toPositionId":%q,"treadMm":"8.0"},
			           {"tyreId":%q,"toPositionId":%q,"treadMm":"8.0"}]}`,
			fitted, rightPos, spare, leftPos)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, tt.path, tenantID.String(), technician.String(), tt.body)
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		})
	}
}

// The handler-level invisibility probe, on every function-backed write
// (D6), not only the one that names a fitment id. Tenant A carries two open
// fitments on a TRAILER, so no removal-odometer rule applies (000025) and a
// rotation of the pair is a legal set; tenant B carries the removal_reasons
// vocabulary its request names and an IN_STOCK casing of its own. Each
// subtest is therefore refused by exactly one thing — RLS hiding tenant A's
// row — and each pins the message of the lookup that did the hiding, because
// a leak answers a DIFFERENT refusal rather than the same one differently
// worded (see each subtest).
func TestFitmentWriteCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _, otherA, leftPosA, rightPosA, sparePosA := plantUnitFixture(t, ctx, admin, "fitment-xten-a")
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	suffix := uuid.NewString()[:8]
	leftTyreA := plantTyre(t, ctx, admin, tenantA, "XTEN-L-"+suffix, nil)
	rightTyreA := plantTyre(t, ctx, admin, tenantA, "XTEN-R-"+suffix, nil)

	tenantB, _ := plantTenant(t, ctx, admin, "fitment-xten-b")
	plantRemovalReasons(t, ctx, admin, tenantB, "WORN")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	tyreB := plantTyre(t, ctx, admin, tenantB, "XTEN-B-"+suffix, nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	fitPathA := "/api/vehicles/" + otherA.String() + "/fitments"
	fitA := func(tyreID, positionID uuid.UUID, tread string) string {
		rec := post(t, h, fitPathA, tenantA.String(), controllerA.String(), fitBody(tyreID, positionID, tread, nil))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var created fitmentCreatedBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
		return created.FitmentID
	}
	leftFit := fitA(leftTyreA, leftPosA, "9.0")
	rightFit := fitA(rightTyreA, rightPosA, "8.0")

	refuses := func(t *testing.T, rec *httptest.ResponseRecorder, message string) {
		t.Helper()
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
			"tenant B reached tenant A's row: RLS leaked it (got %s)", rec.Body.String())
		var ref refusalBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
		require.Equal(t, "TY012", ref.Code)
		require.Equal(t, message, ref.Message)
	}

	// A leak would let this SUCCEED outright: the fitment is open, its unit
	// is a TRAILER so no removal odometer is required, and "WORN" is in
	// tenant B's own vocabulary.
	t.Run("remove", func(t *testing.T) {
		refuses(t, post(t, h, "/api/fitments/"+leftFit+"/remove", tenantB.String(), controllerB.String(),
			`{"reason":"WORN","treadMm":"4.0"}`), "no such fitment in this fleet")
	})

	// The casing named is tenant B's own and IN_STOCK, so app.fit_tyre's
	// three TY012 tyre-state guards — no such tyre, already FITTED, and any
	// state other than IN_STOCK — all pass before the unit is ever looked up.
	// The refusal below can only be the unit lookup, and only RLS can make
	// that one fail. A leak could not answer this same refusal differently
	// worded: it would get past the lookup to fitment_vehicle_id_fkey, whose
	// composite (tenant_id, vehicle_id) pair is unsatisfiable across tenants,
	// and answer 23503 as invalid_submission — so the code is pinned as well
	// as the message.
	t.Run("fit", func(t *testing.T) {
		refuses(t, post(t, h, "/api/vehicles/"+otherA.String()+"/fitments", tenantB.String(), controllerB.String(),
			fitBody(tyreB, sparePosA, "9.0", nil)), "no such unit in this fleet")
	})

	// A leak would let this SUCCEED outright too: both fitments are open on
	// one TRAILER and the two moves are a legal swap, which is why the unit
	// lookup app.rotate_tyres opens with is the only thing that can refuse it.
	t.Run("rotate", func(t *testing.T) {
		swap := fmt.Sprintf(`{"moves":[{"tyreId":%q,"toPositionId":%q,"treadMm":"8.5"},
		                              {"tyreId":%q,"toPositionId":%q,"treadMm":"7.5"}]}`,
			leftTyreA, rightPosA, rightTyreA, leftPosA)
		refuses(t, post(t, h, "/api/vehicles/"+otherA.String()+"/rotations", tenantB.String(), controllerB.String(),
			swap), "no such unit in this fleet")
	})

	// Tenant A's two fitments are still the same open rows on the same
	// positions, and tenant B's casing is on nothing.
	for _, want := range []struct {
		fitmentID string
		position  uuid.UUID
	}{{leftFit, leftPosA}, {rightFit, rightPosA}} {
		var positionID uuid.UUID
		var removedAt *string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT position_id, removed_at::text FROM app.fitment WHERE id = $1`,
			want.fitmentID).Scan(&positionID, &removedAt))
		require.Equal(t, want.position, positionID, "tenant A's fitment did not move")
		require.Nil(t, removedAt, "tenant A's fitment is still open")
	}
	var strayed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.fitment WHERE tyre_id = $1`, tyreB).Scan(&strayed))
	require.Zero(t, strayed, "tenant B's casing was not fitted to another fleet's unit")
}

// Shape refusals the handler owns, answered before any transaction opens
// (ADR-0013 d.5), and the one it deliberately does not own. An instant that
// will not parse and an orientation outside app.mount_orientation would both
// otherwise reach a cast and come back as a SQLSTATE mapped to nothing
// useful — 22007/22008 is in no map at all, which is a 500 for a client typo.
func TestFitmentWriteRefusesMalformedFields(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _, other, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "fit-malformed")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	tyreID := plantTyre(t, ctx, admin, tenantID, "MALFORMED-"+uuid.NewString()[:8], nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/vehicles/" + other.String() + "/fitments"

	// Parsed in Go, so the field is named back to the caller; a raw
	// "yesterday" reaching $7::timestamptz is a 500.
	badInstant := post(t, h, path, tenantID.String(), controller.String(), fmt.Sprintf(
		`{"tyreId":%q,"positionId":%q,"treadMm":"9.0","mountOrientation":"MARK_OUTBOARD","occurredAt":"yesterday"}`,
		tyreID, leftPos))
	require.Equal(t, http.StatusUnprocessableEntity, badInstant.Code, badInstant.Body.String())
	var instantRef refusalBody
	require.NoError(t, json.Unmarshal(badInstant.Body.Bytes(), &instantRef))
	require.Equal(t, "invalid_submission", instantRef.Code)
	require.Contains(t, instantRef.Message, "occurredAt")

	// The enum cast is the authority on which orientations exist (D13), so
	// this arrives as 22P02 and is mapped, not as a list duplicated in Go.
	badOrientation := post(t, h, path, tenantID.String(), controller.String(), fmt.Sprintf(
		`{"tyreId":%q,"positionId":%q,"treadMm":"9.0","mountOrientation":"SIDEWAYS"}`,
		tyreID, leftPos))
	require.Equal(t, http.StatusUnprocessableEntity, badOrientation.Code, badOrientation.Body.String())

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.fitment WHERE tyre_id = $1`, tyreID).Scan(&landed))
	require.Zero(t, landed, "neither refusal wrote a fitment")
}

// The WITH CHECK half, which no handler can reach: every handler binds
// tenant_id from the session, so only a raw insert naming another tenant
// exercises it (admin_test.go's TestWriteAimedAtAnotherTenantIsRefused).
// Every id is tenant B's own and created_by is a real tenant-B user, so the
// composite FKs (000017) cannot be what refuses this row — the one thing
// wrong with it is that tenant A is writing it (lesson 2026-08-28).
func TestWriteAimedAtAnotherTenantIsRefused_Fitment(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _, _, _, _, _ := plantUnitFixture(t, ctx, admin, "fitment-withcheck-a")
	tenantB, _, otherB, leftPosB, _, _ := plantUnitFixture(t, ctx, admin, "fitment-withcheck-b")
	userA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	userB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	tyreB := plantTyre(t, ctx, admin, tenantB, "SMUGGLED-FIT-"+uuid.NewString()[:8], nil)

	err := s.InActorTx(ctx, tenantA, userA, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
			                          fitted_odometer, fitted_tread_mm, mount_orientation, created_by)
			 VALUES ($1, $2, $3, $4, now(), 1000, 9.0, 'MARK_OUTBOARD'::app.mount_orientation, $5)`,
			tenantB, tyreB, otherB, leftPosB, userB)
		return err
	})
	require.Error(t, err, "a fitment aimed at another tenant was accepted")

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	// 42501 is insufficient_privilege, which is how row-level security
	// refuses a write it will not admit.
	require.Equal(t, "42501", pgErr.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.fitment WHERE tyre_id = $1`, tyreB).Scan(&landed))
	require.Zero(t, landed)
}

// maxTextLen on the four free-text fields the fitment surface added. The
// actor is a DRIVER, which holds none of the capabilities these three
// handlers require — so a 422 is only possible if the length check runs
// before withActor opens a transaction, and the control at the end (the same
// actor, the same route, a short value) is what shows the 403 is otherwise
// what this actor gets. Nothing is planted beyond the tenant and the user:
// every id below is a random uuid, and a handler that reached the database
// with one would answer 404 or a refusal rather than 422.
func TestFitmentTextFieldsAreLengthCapped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "text-cap")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	long := strings.Repeat("x", 201)
	fitPath := "/api/vehicles/" + uuid.NewString() + "/fitments"
	removePath := "/api/fitments/" + uuid.NewString() + "/remove"
	returnPath := "/api/retread-jobs/" + uuid.NewString() + "/return"

	fitWithReason := func(reason string) string {
		return fmt.Sprintf(
			`{"tyreId":%q,"positionId":%q,"treadMm":"9.0","mountOrientation":"MARK_OUTBOARD","reason":%q}`,
			uuid.NewString(), uuid.NewString(), reason)
	}

	for _, tc := range []struct{ name, path, body, field string }{
		{"fit reason", fitPath, fitWithReason(long), "reason"},
		{"removal reason", removePath, fmt.Sprintf(`{"reason":%q,"treadMm":"4.0"}`, long), "reason"},
		{"backdate reason", removePath,
			fmt.Sprintf(`{"reason":"WORN","treadMm":"4.0","backdateReason":%q}`, long), "backdateReason"},
		{"retread report reference", returnPath,
			fmt.Sprintf(`{"returnedOn":"2026-09-01","casingAccepted":true,"reportReference":%q}`, long),
			"reportReference"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, h, tc.path, tenantID.String(), driver.String(), tc.body)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Contains(t, ref.Message, tc.field, "the refusal names the field the caller sent")
		})
	}

	// The control: the same routes and the same actor, with the capped field at
	// maxTextLen rather than one over. Each answers 403 — so the 422s above are
	// the cap, not the route, the actor or anything else in the request. The
	// remove route has one control for its two capped fields: it holds
	// backdateReason at the cap beside a short reason, so it is a one-field
	// delta from the backdate-reason row and not from the removal-reason one.
	for _, tc := range []struct{ name, path, body string }{
		{"fit", fitPath, fitWithReason(strings.Repeat("x", 200))},
		{"remove", removePath, fmt.Sprintf(`{"reason":"WORN","treadMm":"4.0","backdateReason":%q}`,
			strings.Repeat("x", 200))},
		{"retread return", returnPath,
			fmt.Sprintf(`{"returnedOn":"2026-09-01","casingAccepted":true,"reportReference":%q}`,
				strings.Repeat("x", 200))},
	} {
		t.Run(tc.name+" at the cap reaches the gate", func(t *testing.T) {
			rec := post(t, h, tc.path, tenantID.String(), driver.String(), tc.body)
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		})
	}
}

// The five surfaces B5 added whose capability gate nothing asserted. Each
// row's 403 can only come from the require() call named beside it: withActor
// answers 403 in exactly two places (httpapi.go's errForbidden branch and its
// store.ErrNoSuchActor branch), and every actor below is a live user of the
// tenant it calls with, so the second branch cannot fire.
//
// The TECHNICIAN rows are what make the ManageAssets ones discriminate. That
// role holds ViewFleet and nothing else (auth.go's capabilities map), so the
// same actor is admitted to the two ViewFleet reads and refused the three
// ManageAssets surfaces — the gate under test is the capability itself, not
// tenant membership and not the route.
func TestFitmentSurfaceEndpointsAreCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, mine, _, _, _, _ := plantUnitFixture(t, ctx, admin, "fitment-gate")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	tyreID := plantRemovedTyre(t, ctx, admin, tenantID, "GATE-"+uuid.NewString()[:8])
	retreader, _ := plantDepotOfType(t, ctx, admin, tenantID, "RETREADER")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// A dispatch body that would otherwise be accepted: destination, depotId
	// and the date are all validated ahead of withActor (tyres.go's
	// dispatchTyre), so a malformed one would answer 422 and prove nothing
	// about the gate behind it.
	dispatchBody := fmt.Sprintf(`{"destination":"AT_RETREADER","depotId":%q}`, retreader)

	for _, tc := range []struct {
		name   string
		method string
		path   string
		body   string
		actor  uuid.UUID
		want   int
	}{
		// units.go listDepots: require(a, auth.ManageAssets). Of these five
		// it is the one read gated on a write capability — a depot list is
		// the dispatch and return forms' picker, so a role that may not act
		// on it has no use for it. The TECHNICIAN row is what proves the gate
		// is ManageAssets and not ViewFleet.
		{"depots refuse a technician", http.MethodGet, "/api/depots", "", technician, http.StatusForbidden},
		{"depots refuse a driver", http.MethodGet, "/api/depots", "", driver, http.StatusForbidden},

		// units.go listOpenFitments: require(a, auth.ViewFleet). open=true is
		// on the path because the unsupported-filter 400 is written before
		// withActor is entered, so a bare /api/fitments would answer 400 and
		// never reach the gate.
		{"open fitments refuse a driver", http.MethodGet, "/api/fitments?open=true", "", driver, http.StatusForbidden},
		{"open fitments admit a technician", http.MethodGet, "/api/fitments?open=true", "", technician, http.StatusOK},

		// units.go listUnitFitments: require(a, auth.ViewFleet).
		{"unit fitments refuse a driver", http.MethodGet, "/api/vehicles/" + mine.String() + "/fitments", "",
			driver, http.StatusForbidden},
		{"unit fitments admit a technician", http.MethodGet, "/api/vehicles/" + mine.String() + "/fitments", "",
			technician, http.StatusOK},

		// tyres.go dispatchTyre: require(a, auth.ManageAssets).
		{"dispatch refuses a driver", http.MethodPost, "/api/tyres/" + tyreID.String() + "/dispatch", dispatchBody,
			driver, http.StatusForbidden},
		{"dispatch refuses a technician", http.MethodPost, "/api/tyres/" + tyreID.String() + "/dispatch", dispatchBody,
			technician, http.StatusForbidden},

		// tyres.go returnTyreToStock: require(a, auth.ManageAssets). An empty
		// body is a valid request here — depotId is optional — so the refusal
		// cannot be a validation one.
		{"return refuses a driver", http.MethodPost, "/api/tyres/" + tyreID.String() + "/return", `{}`,
			driver, http.StatusForbidden},
		{"return refuses a technician", http.MethodPost, "/api/tyres/" + tyreID.String() + "/return", `{}`,
			technician, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var rec *httptest.ResponseRecorder
			if tc.method == http.MethodGet {
				rec = get(t, h, tc.path, tenantID.String(), tc.actor.String())
			} else {
				rec = post(t, h, tc.path, tenantID.String(), tc.actor.String(), tc.body)
			}
			require.Equal(t, tc.want, rec.Code, rec.Body.String())
			if tc.want != http.StatusForbidden {
				return
			}
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "forbidden", ref.Code)
			require.Equal(t, "this action is not permitted for this role", ref.Message)
		})
	}

	// Nothing the refused writes named moved: a 403 is refused before
	// app.dispatch_tyre and app.return_tyre_to_stock are ever called.
	var state string
	var jobs int
	require.NoError(t, admin.QueryRow(ctx, `SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "REMOVED", state)
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.retread_job WHERE tyre_id = $1`, tyreID).Scan(&jobs))
	require.Zero(t, jobs)
}
