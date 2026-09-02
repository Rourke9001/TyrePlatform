package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type retreadJobBody struct {
	ID          string `json:"id"`
	TyreID      string `json:"tyreId"`
	DisplayCode string `json:"displayCode"`
	DepotName   string `json:"depotName"`
	SentAt      string `json:"sentAt"`
	DaysOut     int    `json:"daysOut"`
}

// plantOpenRetreadJob plants a retreader depot, a tyre AT_RETREADER, and the
// open retread_job row (returned_at NULL) that put it there — the fixture
// shape app.dispatch_tyre's own INSERT produces (000033), planted directly
// since dispatching a casing (TYRE-93) is a separate write surface.
//
// sent_at is computed from app.tenant_today(tn.timezone), never from the
// session's wall clock: `now()::date` is the container's UTC calendar, which
// agrees with a South African tenant's civil date for most of the day but
// disagrees with it — and with an extreme-zone tenant's for a much wider
// window — for the hours either side of the tenant's own midnight, so a
// daysOut assertion built on it would pass by coincidence rather than by the
// tenant-zone rule actually holding.
func plantOpenRetreadJob(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, sentDaysAgo int) (jobID, tyreID uuid.UUID, depotName string) {
	t.Helper()
	suffix := uuid.NewString()[:8]
	depotName = "retreader-" + suffix
	var depotID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'RETREADER'::app.depot_type) RETURNING id`,
		tenantID, depotName,
	).Scan(&depotID))

	tyreID = plantTyre(t, ctx, admin, tenantID, "RETREAD-JOB-"+suffix, nil)
	_, err := admin.Exec(ctx,
		`UPDATE app.tyre SET state = 'AT_RETREADER'::app.tyre_state, current_depot_id = $2 WHERE id = $1`,
		tyreID, depotID)
	require.NoError(t, err)

	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.retread_job (tenant_id, tyre_id, retreader_depot_id, sent_at)
		 VALUES ($1, $2, $3,
		         (SELECT app.tenant_today(tn.timezone) FROM app.tenant tn WHERE tn.id = $1) - $4::int)
		 RETURNING id`,
		tenantID, tyreID, depotID, sentDaysAgo,
	).Scan(&jobID))
	return jobID, tyreID, depotName
}

// The retread queue is gated on LogRetread (D6): a TECHNICIAN reads the
// fleet but does not act on the retread queue, refused exactly like the tyre
// register (tyres.go's listTyres); CONTROLLER holds LogRetread and reads it.
func TestRetreadJobsRequireLogRetread(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "retread-gate")
	jobID, tyreID, depotName := plantOpenRetreadJob(t, ctx, admin, tenantID, 3)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusForbidden,
		get(t, h, "/api/retread-jobs?open=true", tenantID.String(), technician.String()).Code)

	rec := get(t, h, "/api/retread-jobs?open=true", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var jobs []retreadJobBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &jobs))
	require.Len(t, jobs, 1)
	require.Equal(t, jobID.String(), jobs[0].ID)
	require.Equal(t, tyreID.String(), jobs[0].TyreID)
	require.Equal(t, depotName, jobs[0].DepotName)
	require.Equal(t, 3, jobs[0].DaysOut, "daysOut is computed in the tenant's own civil calendar")

	// open=true is required, like /api/fitments — refused before a
	// transaction opens rather than answering an unfiltered "every job ever
	// sent" list this slice does not build.
	require.Equal(t, http.StatusBadRequest,
		get(t, h, "/api/retread-jobs", tenantID.String(), controller.String()).Code)
}

// Two tenants 25 hours apart cannot share a civil date at any instant
// (admin_test.go's TestAssignmentDefaultsToTheTenantDay uses the same pair
// for the same reason), so this holds whatever time CI runs at. A daysOut
// computed from the session's own wall clock would answer 2 or 4 for
// whichever tenant's local midnight the run straddles; both must read
// exactly 3.
func TestRetreadJobDaysOutIsTenantLocal(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	east, _ := plantTenantInZone(t, ctx, admin, "retread-tz-east", "Pacific/Kiritimati") // UTC+14
	west, _ := plantTenantInZone(t, ctx, admin, "retread-tz-west", "Pacific/Midway")     // UTC-11

	for _, tenantID := range []uuid.UUID{east, west} {
		_, _, _ = plantOpenRetreadJob(t, ctx, admin, tenantID, 3)
		controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

		rec := get(t, h, "/api/retread-jobs?open=true", tenantID.String(), controller.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

		var jobs []retreadJobBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &jobs))
		require.Len(t, jobs, 1)
		require.Equal(t, 3, jobs[0].DaysOut, "daysOut is exact in this tenant's own civil calendar")
	}
}

// plantRemovalThreshold plants rule 5's removal threshold, the configuration
// key app.current_removal_threshold_mm resolves. A Go-planted tenant has no
// such row, and app.log_retread_return refuses an accepted return without
// one (TY014) rather than storing a NULL rate, so every Log Retread fixture
// plants it. Backdated for plantRemovalReasons' reason: the resolver reads
// effective_from <= now() inside a later transaction.
func plantRemovalThreshold(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, mm string) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.configuration (tenant_id, key, value, effective_from)
		 VALUES ($1, 'removal_threshold_mm', to_jsonb($2::numeric), now() - interval '1 hour')`,
		tenantID, mm)
	require.NoError(t, err)
}

// retreadReturnBody is the Log Retread request every test below sends, so a
// wire field changing name breaks in one place. Money is a string end to end
// (rule 2): nothing in Go or in a test parses one.
func retreadReturnBody(returnedOn, reportReference, retreadCost, postTreadMm, casingValue string) string {
	return fmt.Sprintf(
		`{"returnedOn":%q,"casingAccepted":true,"reportReference":%q,`+
			`"retreadCost":%q,"postTreadMm":%q,"casingValue":%q}`,
		returnedOn, reportReference, retreadCost, postTreadMm, casingValue)
}

// FR-TYR-018/019: a retread is a new tread on the same casing, re-rated at
// what that tread cost, and this is the one test that watches the money
// reach the wire. The expected rate is fetched from app.rand_per_mm on the
// figures the function stored — the test computes nothing (rule 2), and the
// cost carries three decimals so that a rate derived before the
// numeric(12,2) rounding lands on a different number from one derived after
// it (lesson 2026-09-01: a parameter's numeric(p,s) is discarded, only a
// local rounds).
func TestLogRetreadReturnPropagates(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "retread-return")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	plantRemovalThreshold(t, ctx, admin, tenantID, "4.0")
	jobID, tyreID, _ := plantOpenRetreadJob(t, ctx, admin, tenantID, 3)

	const retreadCost, postTreadMm, casingValue = "2500.005", "12.0", "800.00"

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/retread-jobs/"+jobID.String()+"/return", tenantID.String(), controller.String(),
		retreadReturnBody(tenantToday(t, ctx, admin, tenantID), "RPT-8841",
			retreadCost, postTreadMm, casingValue))
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	// The same function, on the same inputs, inside the tenant's own session
	// so app.current_removal_threshold_mm resolves — never arithmetic here.
	var expectedRate string
	require.NoError(t, s.InActorTx(ctx, tenantID, controller, func(tx pgx.Tx, _ auth.Actor) error {
		return tx.QueryRow(ctx,
			`SELECT app.rand_per_mm($1::numeric(12,2), $2::numeric(4,1),
			                        app.current_removal_threshold_mm())::text`,
			retreadCost, postTreadMm).Scan(&expectedRate)
	}))

	listRec := get(t, h, "/api/tyres", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, listRec.Code, listRec.Body.String())
	var listed tyresListBody
	require.NoError(t, json.Unmarshal(listRec.Body.Bytes(), &listed))
	var casing *tyreBody
	for i := range listed.Tyres {
		if listed.Tyres[i].ID == tyreID.String() {
			casing = &listed.Tyres[i]
		}
	}
	require.NotNil(t, casing, "the returned casing is back in the register")
	require.Equal(t, "RETREAD", casing.Status)
	require.Equal(t, 1, casing.RetreadCount)
	require.Equal(t, "IN_STOCK", casing.State)
	require.NotNil(t, casing.RandPerMm, "a CONTROLLER holds ViewValuation, so money is projected")
	require.Equal(t, expectedRate, *casing.RandPerMm,
		"the rate on the wire is app.rand_per_mm's own, at the precision it stored")

	// FR-FIT-021/022: the job is closed with its turnaround and the
	// retreader's figure is a casing valuation citing it.
	var turnaround int
	var reportReference string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT turnaround_days, report_reference FROM app.retread_job WHERE id = $1`,
		jobID).Scan(&turnaround, &reportReference))
	require.Equal(t, 3, turnaround)
	require.Equal(t, "RPT-8841", reportReference)

	var valuations int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.casing_valuation
		  WHERE retread_job_id = $1 AND source = 'RETREADER' AND value = $2::numeric`,
		jobID, casingValue).Scan(&valuations))
	require.Equal(t, 1, valuations)
}

// D6: Log Retread is the capability's first write, and it is the one thing
// on this surface a ManageAssets holder alone may not do. TECHNICIAN is the
// probe because it is the only role that holds neither (it holds ViewFleet
// alone) — which means this 403 proves a gate exists, not which capability
// it names: no tenant role today holds ManageAssets without LogRetread, so
// the two cannot be told apart by driving a handler (ADR-0011). The body is
// well formed throughout, so the refusal is provably the gate and not the
// shape validation that runs ahead of it.
func TestLogRetreadRequiresLogRetread(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "retread-return-gate")
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	plantRemovalThreshold(t, ctx, admin, tenantID, "4.0")
	jobID, _, _ := plantOpenRetreadJob(t, ctx, admin, tenantID, 1)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/retread-jobs/"+jobID.String()+"/return", tenantID.String(), technician.String(),
		retreadReturnBody(tenantToday(t, ctx, admin, tenantID), "RPT-GATE", "1000.00", "12.0", "500.00"))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	var returnedAt *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT returned_at::text FROM app.retread_job WHERE id = $1`, jobID).Scan(&returnedAt))
	require.Nil(t, returnedAt, "the refused request closed nothing")
}

// The invisibility probe for the one write that names a retread job. Tenant
// A's job is genuinely open with its casing AT_RETREADER, and tenant B holds
// its own cap and its own removal threshold — so a leak would let this
// SUCCEED outright rather than merely change the wording of a refusal, which
// is what makes the probe worth having (lesson 2026-09-01: two branches
// sharing a SQLSTATE make a cross-tenant probe vacuous).
func TestRetreadReturnCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "retread-xten-a")
	jobA, tyreA, _ := plantOpenRetreadJob(t, ctx, admin, tenantA, 2)

	tenantB, _ := plantTenant(t, ctx, admin, "retread-xten-b")
	plantFleetRetreadPolicy(t, ctx, admin, tenantB, 2)
	plantRemovalThreshold(t, ctx, admin, tenantB, "4.0")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/retread-jobs/"+jobA.String()+"/return", tenantB.String(), controllerB.String(),
		retreadReturnBody(tenantToday(t, ctx, admin, tenantB), "RPT-XTEN", "1000.00", "12.0", "500.00"))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
		"tenant B closed tenant A's retread job: RLS leaked the row (got %s)", rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such open retread job in this fleet", ref.Message)

	var returnedAt *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT returned_at::text FROM app.retread_job WHERE id = $1`, jobA).Scan(&returnedAt))
	require.Nil(t, returnedAt, "tenant A's job is still open")

	var state string
	var retreadCount int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text, retread_count FROM app.tyre WHERE id = $1`, tyreA).Scan(&state, &retreadCount))
	require.Equal(t, "AT_RETREADER", state, "tenant A's casing did not come back")
	require.Zero(t, retreadCount)
}

// returnedOn is parsed in Go before the transaction opens, like the
// dispatch's sentOn: 22007/22008 is in no map here, so an unparsed date
// would answer 500 for a client typo instead of naming the field.
func TestLogRetreadReturnRefusesMalformedReturnedOn(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "retread-bad-date")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	plantRemovalThreshold(t, ctx, admin, tenantID, "4.0")
	jobID, _, _ := plantOpenRetreadJob(t, ctx, admin, tenantID, 1)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/retread-jobs/"+jobID.String()+"/return", tenantID.String(), controller.String(),
		retreadReturnBody("31-12-2026", "RPT-BAD", "1000.00", "12.0", "500.00"))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "returnedOn")

	var returnedAt *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT returned_at::text FROM app.retread_job WHERE id = $1`, jobID).Scan(&returnedAt))
	require.Nil(t, returnedAt, "the refusal never reached the database")
}

// The presence check the handler owns (ADR-0013 d.5): whether the key is
// there is the request's shape, and its absence must never reach the bare
// bool's false, which is the rejection that scraps the casing. Refused
// before any transaction opens, in the same vocabulary as the two required
// strings beside it.
func TestLogRetreadReturnRequiresTheCasingDecision(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "retread-no-decision")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	plantRemovalThreshold(t, ctx, admin, tenantID, "4.0")
	jobID, tyreID, _ := plantOpenRetreadJob(t, ctx, admin, tenantID, 1)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/retread-jobs/"+jobID.String()+"/return", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"returnedOn":%q,"reportReference":"RPT-NODEC"}`,
			tenantToday(t, ctx, admin, tenantID)))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "casingAccepted")

	var returnedAt *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT returned_at::text FROM app.retread_job WHERE id = $1`, jobID).Scan(&returnedAt))
	require.Nil(t, returnedAt, "the refused request closed nothing")
	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "AT_RETREADER", state, "an absent decision scrapped nothing")
}

// U9, FR-TYR-009, BR-VAL-004: the rejection is the other half of D3 and the
// destructive one. A rejected casing carries no cost and no value, is
// scrapped rather than restocked, and gets a zero RETREADER valuation citing
// the job — an absent figure would read as UNVALUED, which is a different
// claim from a casing the retreader inspected and found worthless. The
// retread count does not move: a rejection is not a retread.
func TestLogRetreadReturnRejectedCasingIsScrapped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "retread-rejected")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	plantRemovalThreshold(t, ctx, admin, tenantID, "4.0")
	jobID, tyreID, _ := plantOpenRetreadJob(t, ctx, admin, tenantID, 2)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/retread-jobs/"+jobID.String()+"/return", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"returnedOn":%q,"casingAccepted":false,"reportReference":"RPT-REJECT"}`,
			tenantToday(t, ctx, admin, tenantID)))
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	var state string
	var retreadCount int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text, retread_count FROM app.tyre WHERE id = $1`, tyreID).Scan(&state, &retreadCount))
	require.Equal(t, "SCRAPPED", state)
	require.Zero(t, retreadCount, "a rejection is not a retread")

	var zeroValuations int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.casing_valuation
		  WHERE retread_job_id = $1 AND source = 'RETREADER' AND value = 0`,
		jobID).Scan(&zeroValuations))
	require.Equal(t, 1, zeroValuations, "the rejection is recorded as a valuation, not as an absence")
}
