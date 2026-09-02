package httpapi_test

import (
	"context"
	"encoding/json"
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
