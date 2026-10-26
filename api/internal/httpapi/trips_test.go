package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type tripUnitBody struct {
	VehicleID   string `json:"vehicleId"`
	FleetNumber string `json:"fleetNumber"`
}

type tripBody struct {
	ID     string       `json:"id"`
	Motive tripUnitBody `json:"motive"`
	Driver struct {
		UserID      string `json:"userId"`
		DisplayName string `json:"displayName"`
	} `json:"driver"`
	StartedAt string `json:"startedAt"`
	StartedBy *struct {
		UserID string `json:"userId"`
	} `json:"startedBy"`
	EndedAt  *string        `json:"endedAt"`
	Trailers []tripUnitBody `json:"trailers"`
}

type unitTripBody struct {
	Trip     *tripBody     `json:"trip"`
	PulledBy *tripUnitBody `json:"pulledBy"`
}

// plantHomedUnit plants a unit of kind on a configuration of its own, homed
// at depotID (nil for none).
func plantHomedUnit(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, kind string, depotID *uuid.UUID) uuid.UUID {
	t.Helper()
	id := plantRigUnit(t, ctx, admin, tenantID, kind)
	_, err := admin.Exec(ctx, `UPDATE app.vehicle SET home_depot_id = $2 WHERE id = $1`, id, depotID)
	require.NoError(t, err)
	return id
}

func startTripBody(motive, driver uuid.UUID, trailers ...uuid.UUID) string {
	ids := make([]string, 0, len(trailers))
	for _, tr := range trailers {
		ids = append(ids, tr.String())
	}
	raw, _ := json.Marshal(map[string]any{
		"motiveVehicleId": motive.String(), "driverUserId": driver.String(), "addTrailers": ids,
	})
	return string(raw)
}

func decodeTrip(t *testing.T, body []byte) tripBody {
	t.Helper()
	var trip tripBody
	require.NoError(t, json.Unmarshal(body, &trip))
	return trip
}

func unitTrip(t *testing.T, h http.Handler, tenantID, actor, unitID uuid.UUID) unitTripBody {
	t.Helper()
	rec := get(t, h, "/api/vehicles/"+unitID.String()+"/trip", tenantID.String(), actor.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out unitTripBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func TestStartTripOpensATripAndAddsTrailers(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, first := plantRigUnits(t, ctx, admin, "trip-start")
	second := plantRigUnit(t, ctx, admin, tenantID, "TRAILER")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(horse, driver, second, first))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	trip := decodeTrip(t, rec.Body.Bytes())
	require.Equal(t, horse.String(), trip.Motive.VehicleID)
	require.Equal(t, driver.String(), trip.Driver.UserID)
	require.NotNil(t, trip.StartedBy)
	require.Equal(t, controller.String(), trip.StartedBy.UserID)
	require.Nil(t, trip.EndedAt)
	require.Equal(t, []tripUnitBody{
		{second.String(), fleetNumberOf(t, ctx, admin, second)},
		{first.String(), fleetNumberOf(t, ctx, admin, first)},
	}, trip.Trailers, "the trailers in the order sent")

	panel := unitTrip(t, h, tenantID, controller, horse)
	require.NotNil(t, panel.Trip)
	require.Equal(t, trip.ID, panel.Trip.ID)
	require.Nil(t, panel.PulledBy)
	panel = unitTrip(t, h, tenantID, controller, first)
	require.NotNil(t, panel.PulledBy)
	require.Equal(t, horse.String(), panel.PulledBy.VehicleID)
	require.Equal(t, trip.ID, panel.Trip.ID)

	rec = get(t, h, "/api/my/trip", tenantID.String(), driver.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var mine struct {
		Trip *tripBody `json:"trip"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &mine))
	require.NotNil(t, mine.Trip)
	require.Equal(t, trip.ID, mine.Trip.ID)

	require.ElementsMatch(t,
		[]string{fleetNumberOf(t, ctx, admin, horse), fleetNumberOf(t, ctx, admin, first), fleetNumberOf(t, ctx, admin, second)},
		fleetNumbers(t, get(t, h, "/api/my/vehicles", tenantID.String(), driver.String())))
}

func TestStartTripClosesTheDriversOtherTrip(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, _ := plantRigUnits(t, ctx, admin, "trip-close")
	other := plantRigUnit(t, ctx, admin, tenantID, "HORSE")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(horse, driver))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	first := decodeTrip(t, rec.Body.Bytes())
	rec = post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(other, driver))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var ended *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT ended_at::text FROM app.trip WHERE id = $1`, first.ID).Scan(&ended))
	require.NotNil(t, ended, "the driver's first trip ended when the second started")
	require.Nil(t, unitTrip(t, h, tenantID, controller, horse).Trip)
}

func TestStartTripRefusals(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, trailer := plantRigUnits(t, ctx, admin, "trip-refuse")
	elsewhere := plantRigUnit(t, ctx, admin, tenantID, "HORSE")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	inactive := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	_, err := admin.Exec(ctx, `UPDATE app.app_user SET active = false WHERE id = $1`, inactive)
	require.NoError(t, err)
	// The trailer is coupled to another horse, so it is not free.
	var rig uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
		 VALUES ($1, $2, now() - interval '1 hour') RETURNING id`, tenantID, elsewhere).Scan(&rig))
	_, err = admin.Exec(ctx,
		`INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
		 VALUES ($1, $2, $3, 1), ($1, $2, $4, 2)`, tenantID, rig, elsewhere, trailer)
	require.NoError(t, err)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	cases := []struct {
		name, body, code, message string
	}{
		{"a trailer as the motive", startTripBody(trailer, driver), "TY028",
			"a trip is driven on a horse, rigid or light vehicle; " + fleetNumberOf(t, ctx, admin, trailer) + " is a trailer"},
		{"a trailer coupled elsewhere", startTripBody(horse, driver, trailer), "TY028",
			fleetNumberOf(t, ctx, admin, trailer) + " is coupled to " + fleetNumberOf(t, ctx, admin, elsewhere) +
				"; free it before adding it to this trip"},
		{"an inactive driver", startTripBody(horse, inactive), "TY028",
			displayNameOf(t, ctx, admin, inactive) + " is no longer active"},
		{"a driver whose role cannot capture", startTripBody(horse, technician), "invalid_submission",
			"driverUserId names a user whose role cannot capture inspections"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, h, "/api/trips", tenantID.String(), controller.String(), tc.body)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			ref := decodeRefusal(t, rec.Body.Bytes())
			require.Equal(t, tc.code, ref.Code)
			require.Equal(t, tc.message, ref.Message)
		})
	}
	for _, tc := range []struct{ body, field string }{
		{fmt.Sprintf(`{"driverUserId":%q}`, driver), "motiveVehicleId"},
		{fmt.Sprintf(`{"motiveVehicleId":%q,"driverUserId":%q,"addTrailers":["nope"]}`, horse, driver), "addTrailers[0]"},
	} {
		rec := post(t, h, "/api/trips", tenantID.String(), controller.String(), tc.body)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
		ref := decodeRefusal(t, rec.Body.Bytes())
		require.Equal(t, "invalid_submission", ref.Code)
		require.Contains(t, ref.Message, tc.field)
	}
	var n int
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.trip WHERE tenant_id = $1`, tenantID).Scan(&n))
	require.Zero(t, n)
}

func TestEndTrip(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, trailer := plantRigUnits(t, ctx, admin, "trip-end")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(horse, driver, trailer))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	trip := decodeTrip(t, rec.Body.Bytes())

	rec = post(t, h, "/api/trips/"+trip.ID+"/end", tenantID.String(), controller.String(), ``)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	ended := decodeTrip(t, rec.Body.Bytes())
	require.NotNil(t, ended.EndedAt)
	require.Len(t, ended.Trailers, 1, "the rig stays coupled")
	var open int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.combination WHERE motive_vehicle_id = $1 AND effective_to IS NULL`, horse).Scan(&open))
	require.Equal(t, 1, open)

	rec = post(t, h, "/api/trips/"+trip.ID+"/end", tenantID.String(), controller.String(), ``)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY028", ref.Code)
	require.Equal(t, "this trip has already ended; refresh to see who is on the truck now", ref.Message)

	rec = post(t, h, "/api/trips/"+uuid.NewString()+"/end", tenantID.String(), controller.String(), ``)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref = decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such trip in this fleet", ref.Message)
}

func TestTripRoutesAreCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "trip-gate")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	// A technician is depot-scoped (FR-AUT-006), so the horse is homed at
	// their depot.
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	depot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, technician, depot)
	horse := plantHomedUnit(t, ctx, admin, tenantID, "HORSE", &depot)
	trip := plantTrip(t, ctx, admin, tenantID, horse, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusForbidden,
		post(t, h, "/api/trips", tenantID.String(), driver.String(), startTripBody(horse, driver)).Code)
	require.Equal(t, http.StatusForbidden,
		post(t, h, "/api/trips/"+trip.String()+"/end", tenantID.String(), driver.String(), ``).Code)
	require.Equal(t, http.StatusForbidden, get(t, h, "/api/drivers", tenantID.String(), driver.String()).Code)
	require.Equal(t, http.StatusOK,
		get(t, h, "/api/vehicles/"+horse.String()+"/trip", tenantID.String(), technician.String()).Code)
	require.Equal(t, http.StatusForbidden, get(t, h, "/api/my/trip", tenantID.String(), technician.String()).Code)
}

// FR-AUT-008: a depot manager's trip writes are judged by the motive, and a
// start that would end the driver's trip on a truck elsewhere is refused.
// The controller is each refusal's control.
func TestTripWritesAreDepotScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "trip-depot")
	manager := plantUser(t, ctx, admin, tenantID, auth.RoleDepotManager)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	busy := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	mineDepot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	elsewhereDepot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, manager, mineDepot)
	mine := plantHomedUnit(t, ctx, admin, tenantID, "HORSE", &mineDepot)
	away := plantHomedUnit(t, ctx, admin, tenantID, "HORSE", &elsewhereDepot)
	awayTrailer := plantHomedUnit(t, ctx, admin, tenantID, "TRAILER", &elsewhereDepot)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/trips", tenantID.String(), manager.String(), startTripBody(away, driver))
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, "no such unit in this fleet", decodeRefusal(t, rec.Body.Bytes()).Message)
	var n int
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.trip WHERE vehicle_id = $1`, away).Scan(&n))
	require.Zero(t, n)

	awayTrip := plantTrip(t, ctx, admin, tenantID, away, busy)
	rec = post(t, h, "/api/trips/"+awayTrip.String()+"/end", tenantID.String(), manager.String(), ``)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, "no such trip in this fleet", decodeRefusal(t, rec.Body.Bytes()).Message)
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.trip WHERE id = $1 AND ended_at IS NULL`, awayTrip).Scan(&n))
	require.Equal(t, 1, n, "the refused end left the trip open")

	// An added trailer is judged through its motive (spec, Depot scope).
	rec = post(t, h, "/api/trips", tenantID.String(), manager.String(), startTripBody(mine, driver, awayTrailer))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	mineTrip := decodeTrip(t, rec.Body.Bytes())

	rec = post(t, h, "/api/trips", tenantID.String(), manager.String(), startTripBody(mine, busy))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "invalid_submission", ref.Code)
	require.Equal(t, "driverUserId is on the trip with "+fleetNumberOf(t, ctx, admin, away)+
		", outside your depots; end it there first", ref.Message)
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.trip WHERE id IN ($1, $2) AND ended_at IS NULL`, awayTrip, mineTrip.ID).Scan(&n))
	require.Equal(t, 2, n, "both trips read as before")

	require.Equal(t, http.StatusOK,
		post(t, h, "/api/trips/"+awayTrip.String()+"/end", tenantID.String(), controller.String(), ``).Code,
		"the control: a controller ends the same trip")
}

func TestDriversListsCapturersAndTheirTrips(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, _ := plantRigUnits(t, ctx, admin, "trip-drivers")
	manager := plantUser(t, ctx, admin, tenantID, auth.RoleDepotManager)
	homeDepot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	otherDepot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, manager, homeDepot)
	onTrip := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	joinDepot(t, ctx, admin, tenantID, onTrip, otherDepot)
	idle := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	inactive := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	_, err := admin.Exec(ctx, `UPDATE app.app_user SET active = false WHERE id = $1`, inactive)
	require.NoError(t, err)
	plantTrip(t, ctx, admin, tenantID, horse, onTrip)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/drivers", tenantID.String(), manager.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var drivers []struct {
		UserID string        `json:"userId"`
		OnTrip *tripUnitBody `json:"onTrip"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &drivers))
	got := map[string]*tripUnitBody{}
	for _, d := range drivers {
		got[d.UserID] = d.OnTrip
	}
	require.ElementsMatch(t,
		[]string{onTrip.String(), idle.String(), controller.String(), orgAdmin.String(), manager.String()},
		keys(got), "active users who can capture, a driver homed in another depot among them")
	require.NotNil(t, got[onTrip.String()])
	require.Equal(t, horse.String(), got[onTrip.String()].VehicleID)
	require.Nil(t, got[idle.String()])
	require.NotContains(t, keys(got), technician.String())
	require.NotContains(t, keys(got), inactive.String())
}

func keys(m map[string]*tripUnitBody) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestUnitTripCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	_, horseA, _ := plantRigUnits(t, ctx, admin, "trip-xten-a")
	tenantB, _ := plantTenant(t, ctx, admin, "trip-xten-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/vehicles/"+horseA.String()+"/trip", tenantB.String(), controllerB.String())
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, "no such unit in this fleet", decodeRefusal(t, rec.Body.Bytes()).Message)
}

// U148. Every due instant is planted from the tenant's own calendar and
// every expected date is read back in SQL, never from the runner's clock,
// which reads a different day for two hours each night (lesson 2026-09-03).
func TestStartTripIsBlockedByADueInspection(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, trailer := plantRigUnits(t, ctx, admin, "trip-gate-due")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	plantDue := func(unit uuid.UUID, instant string) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		require.NoError(t, admin.QueryRow(ctx, `
			INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
			SELECT t.id, $2, (`+instant+`), now() - interval '12 hours'
			  FROM app.tenant t WHERE t.id = $1 RETURNING id`, tenantID, unit).Scan(&id))
		return id
	}
	const endOfYesterday = `(app.tenant_today(t.timezone)::timestamp AT TIME ZONE t.timezone) - interval '1 microsecond'`
	const endOfToday = `((app.tenant_today(t.timezone) + 1)::timestamp AT TIME ZONE t.timezone) - interval '1 microsecond'`
	const startOfTomorrow = `(app.tenant_today(t.timezone) + 1)::timestamp AT TIME ZONE t.timezone`
	var yesterday string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT (app.tenant_today(timezone) - 1)::text FROM app.tenant WHERE id = $1`, tenantID).Scan(&yesterday))

	horseTask := plantDue(horse, endOfYesterday)
	rec := post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(horse, driver))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY028", ref.Code)
	require.Equal(t, "a trip cannot start before its due inspections are done: "+
		fleetNumberOf(t, ctx, admin, horse)+" due "+yesterday, ref.Message)
	var n int
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.trip WHERE tenant_id = $1`, tenantID).Scan(&n))
	require.Zero(t, n)

	blockers := func(path string) []struct {
		TaskID      string `json:"taskId"`
		FleetNumber string `json:"fleetNumber"`
		DueAt       string `json:"dueAt"`
	} {
		t.Helper()
		rec := get(t, h, path, tenantID.String(), controller.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out []struct {
			TaskID      string `json:"taskId"`
			FleetNumber string `json:"fleetNumber"`
			DueAt       string `json:"dueAt"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	path := "/api/vehicles/" + horse.String() + "/trip-blockers"
	got := blockers(path)
	require.Len(t, got, 1)
	require.Equal(t, horseTask.String(), got[0].TaskID)
	require.Equal(t, fleetNumberOf(t, ctx, admin, horse), got[0].FleetNumber)
	require.NotEmpty(t, got[0].DueAt)
	trailerTask := plantDue(trailer, endOfToday)
	got = blockers(path + "?addTrailers=" + trailer.String())
	require.Len(t, got, 2)
	require.Equal(t, horseTask.String(), got[0].TaskID, "the motive first, in walk order")
	require.Equal(t, trailerTask.String(), got[1].TaskID)

	// The setting off: nothing blocks.
	_, err := admin.Exec(ctx,
		`INSERT INTO app.configuration (tenant_id, key, value, effective_from)
		 VALUES ($1, 'due_inspection_blocks_trip', 'false'::jsonb, now() - interval '1 second')`, tenantID)
	require.NoError(t, err)
	require.Empty(t, blockers(path+"?addTrailers="+trailer.String()))
	rec = post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(horse, driver))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// A task due tomorrow does not block, with the setting on.
	other := plantRigUnit(t, ctx, admin, tenantID, "HORSE")
	plantDue(other, startOfTomorrow)
	_, err = admin.Exec(ctx,
		`INSERT INTO app.configuration (tenant_id, key, value, effective_from)
		 VALUES ($1, 'due_inspection_blocks_trip', 'true'::jsonb, now() - interval '500 milliseconds')`, tenantID)
	require.NoError(t, err)
	otherPath := "/api/vehicles/" + other.String() + "/trip-blockers"
	require.Empty(t, blockers(otherPath))
	second := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	rec = post(t, h, "/api/trips", tenantID.String(), controller.String(), startTripBody(other, second))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	require.Equal(t, http.StatusForbidden, get(t, h, path, tenantID.String(), driver.String()).Code)
}

// The blockers read in one order, whoever asks and however often a unit is
// named: walk order, then due instant, then task id, so the panel and the
// TY028 message agree (U148). The ids are drawn and sorted so the id order
// runs against the due order.
func TestTripBlockersReadInOneOrder(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horse, trailer := plantRigUnits(t, ctx, admin, "trip-gate-order")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantOpenRig(t, ctx, admin, tenantID, horse, trailer)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	plant := func(id, unit uuid.UUID, instant string) {
		t.Helper()
		_, err := admin.Exec(ctx, `
			INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at, created_at)
			SELECT $3, t.id, $2, (`+instant+`), now() - interval '12 hours'
			  FROM app.tenant t WHERE t.id = $1`, tenantID, unit, id)
		require.NoError(t, err)
	}
	const morning = `(app.tenant_today(t.timezone)::timestamp + interval '6 hours') AT TIME ZONE t.timezone`
	const endOfToday = `((app.tenant_today(t.timezone) + 1)::timestamp AT TIME ZONE t.timezone) - interval '1 microsecond'`
	plant(ids[1], horse, morning)
	plant(ids[0], horse, endOfToday)
	plant(ids[2], horse, endOfToday)
	trailerTask := uuid.New()
	plant(trailerTask, trailer, endOfToday)

	path := fmt.Sprintf("/api/vehicles/%s/trip-blockers?addTrailers=%s,%s,%s", horse, trailer, horse, trailer)
	rec := get(t, h, path, tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got []struct {
		TaskID string `json:"taskId"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	order := make([]string, 0, len(got))
	for _, b := range got {
		order = append(order, b.TaskID)
	}
	require.Equal(t, []string{ids[1].String(), ids[0].String(), ids[2].String(), trailerTask.String()}, order)
}

// FR-AUT-008: the blockers read an added unit only when the start could
// couple it, a free trailer, so a depot manager naming another depot's horse
// or a trailer it tows reads none of their tasks, and a start naming the
// horse is refused by the unit alone. The controller's read of the horse
// itself is the control that both tasks are planted and due.
func TestTripBlockersStayInScope(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "trip-gate-scope")
	manager := plantUser(t, ctx, admin, tenantID, auth.RoleDepotManager)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	mineDepot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	awayDepot, _ := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, manager, mineDepot)
	mine := plantHomedUnit(t, ctx, admin, tenantID, "HORSE", &mineDepot)
	away := plantHomedUnit(t, ctx, admin, tenantID, "HORSE", &awayDepot)
	towed := plantHomedUnit(t, ctx, admin, tenantID, "TRAILER", &awayDepot)
	free := plantHomedUnit(t, ctx, admin, tenantID, "TRAILER", &awayDepot)
	plantOpenRig(t, ctx, admin, tenantID, away, towed)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	plantDue := func(unit uuid.UUID) string {
		t.Helper()
		var id uuid.UUID
		require.NoError(t, admin.QueryRow(ctx, `
			INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
			SELECT t.id, $2, (app.tenant_today(t.timezone)::timestamp AT TIME ZONE t.timezone) - interval '1 microsecond',
			       now() - interval '12 hours'
			  FROM app.tenant t WHERE t.id = $1 RETURNING id`, tenantID, unit).Scan(&id))
		return id.String()
	}
	awayTask, towedTask, freeTask := plantDue(away), plantDue(towed), plantDue(free)
	var yesterday string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT (app.tenant_today(timezone) - 1)::text FROM app.tenant WHERE id = $1`, tenantID).Scan(&yesterday))

	read := func(actor, motive uuid.UUID, added ...uuid.UUID) []string {
		t.Helper()
		path := "/api/vehicles/" + motive.String() + "/trip-blockers"
		if len(added) > 0 {
			path += "?addTrailers=" + added[0].String()
		}
		rec := get(t, h, path, tenantID.String(), actor.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var got []struct {
			TaskID string `json:"taskId"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		ids := make([]string, 0, len(got))
		for _, b := range got {
			ids = append(ids, b.TaskID)
		}
		return ids
	}
	require.Equal(t, []string{awayTask, towedTask}, read(controller, away), "the control")
	for name, actor := range map[string]uuid.UUID{"manager": manager, "controller": controller} {
		require.Empty(t, read(actor, mine, away), "%s naming another depot's horse", name)
		require.Empty(t, read(actor, mine, towed), "%s naming a trailer another truck tows", name)
		require.Equal(t, []string{freeTask}, read(actor, mine, free),
			"%s naming a free trailer elsewhere, judged through the motive (spec, Depot scope)", name)
	}

	rec := post(t, h, "/api/trips", tenantID.String(), manager.String(), startTripBody(mine, driver, away))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY028", ref.Code)
	require.Equal(t, "only a trailer is added to a trip; "+fleetNumberOf(t, ctx, admin, away)+" is a horse", ref.Message)
	require.NotContains(t, ref.Message, yesterday, "the refusal names no due day")
	var n int
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.trip WHERE tenant_id = $1`, tenantID).Scan(&n))
	require.Zero(t, n)
}
