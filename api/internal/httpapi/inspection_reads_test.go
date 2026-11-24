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
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

// twoDepotRig is a horse at depot A towing a trailer at depot B, with a third
// unit at depot C and a manager joined to each depot (TYRE-325, U248 item 3).
// plantUnitFixture homes neither unit, and app.v_depot_vehicle joins on
// home_depot_id, so both are homed here or every depot assertion would pass
// for the wrong reason (observations_test.go's plantTrailer).
type twoDepotRig struct {
	Tenant, Horse, Trailer, Outsider                                  uuid.UUID
	HorseFleet, TrailerFleet                                          string
	LeftPos, RightPos, SparePos                                       uuid.UUID
	Driver, Controller, HorseManager, TrailerManager, OutsiderManager uuid.UUID
}

func plantTwoDepotRig(t *testing.T, ctx context.Context, admin *pgx.Conn, label string) twoDepotRig {
	t.Helper()
	var f twoDepotRig
	f.Tenant, f.Horse, f.Trailer, f.LeftPos, f.RightPos, f.SparePos = plantUnitFixture(t, ctx, admin, label)
	suffix := uuid.NewString()[:8]

	var depotA, depotB uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'DEPOT') RETURNING id`,
		f.Tenant, "depot-a-"+suffix).Scan(&depotA))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'DEPOT') RETURNING id`,
		f.Tenant, "depot-b-"+suffix).Scan(&depotB))
	require.NoError(t, admin.QueryRow(ctx,
		`UPDATE app.vehicle SET home_depot_id = $2 WHERE id = $1 RETURNING fleet_number`,
		f.Horse, depotA).Scan(&f.HorseFleet))
	require.NoError(t, admin.QueryRow(ctx,
		`UPDATE app.vehicle SET home_depot_id = $2 WHERE id = $1 RETURNING fleet_number`,
		f.Trailer, depotB).Scan(&f.TrailerFleet))

	// plantDepotWithVehicle answers the depot and the fleet number, not the
	// unit's id (httpapi_test.go).
	depotC, outsiderFleet := plantDepotWithVehicle(t, ctx, admin, f.Tenant)
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`,
		f.Tenant, outsiderFleet).Scan(&f.Outsider))

	f.Driver = plantUser(t, ctx, admin, f.Tenant, auth.RoleDriver)
	f.Controller = plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	f.HorseManager = plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	f.TrailerManager = plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	f.OutsiderManager = plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	joinDepot(t, ctx, admin, f.Tenant, f.HorseManager, depotA)
	joinDepot(t, ctx, admin, f.Tenant, f.TrailerManager, depotB)
	joinDepot(t, ctx, admin, f.Tenant, f.OutsiderManager, depotC)

	_, err := admin.Exec(ctx,
		`INSERT INTO app.target_pressure (tenant_id, axle_class, target_kpa, effective_from)
		 VALUES ($1, 'STEER'::app.axle_class, 800, now() - interval '30 days')`, f.Tenant)
	require.NoError(t, err)
	return f
}

// plantRigInspection plants one walk-around of the rig addressed to the
// horse, in one transaction for the seal (TY020): a horse reading, a trailer
// reading with a tie at its minimum, a trailer reading with no tread, a
// warning on a trailer reading, two on no reading, and the trailer's spare
// reported absent. onTimeline files the odometer as submit would.
func plantRigInspection(t *testing.T, ctx context.Context, admin *pgx.Conn, f twoDepotRig, submittedAt time.Time, onTimeline bool) uuid.UUID {
	t.Helper()
	tx, err := admin.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()

	var insp uuid.UUID
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer, comment)
		 VALUES ($1, $2, $3, $4, $5::timestamptz - interval '3 minutes', $5, 412300, 'rig walked') RETURNING id`,
		f.Tenant, f.Horse, f.Driver, uuid.New(), submittedAt).Scan(&insp))

	reading := func(vehicle, pos uuid.UUID, pressure *int, treads ...float64) uuid.UUID {
		var id uuid.UUID
		require.NoError(t, tx.QueryRow(ctx,
			`INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id, pressure_kpa, pressure_temperature)
			 VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::int IS NULL THEN 'UNKNOWN' ELSE 'COLD' END::app.temperature_state)
			 RETURNING id`,
			f.Tenant, insp, vehicle, pos, pressure).Scan(&id))
		anatomy := []string{"OUTER", "CENTRE", "INNER"}
		for i, mm := range treads {
			_, err := tx.Exec(ctx,
				`INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, tread_mm, position, orientation_known)
				 VALUES ($1, $2, $3, $4, $5::app.tread_position, true)`,
				f.Tenant, id, i+1, mm, anatomy[i])
			require.NoError(t, err)
		}
		return id
	}
	p790, p640 := 790, 640
	reading(f.Horse, f.LeftPos, &p790, 8.0, 7.5, 8.0)
	trailerLeft := reading(f.Trailer, f.LeftPos, &p640, 5.0, 4.0, 4.0)
	reading(f.Trailer, f.RightPos, nil)

	_, err = tx.Exec(ctx,
		`INSERT INTO app.inspection_warning (tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
		 VALUES ($1, $2, $3, 'FR-INS-037', '640', 'ACKNOWLEDGED', 'CLIENT'),
		        ($1, $2, NULL, 'FR-INS-033', '412300', 'CONFIRMED', 'CLIENT'),
		        ($1, $2, NULL, 'FR-INS-063', $4, NULL, 'SERVER')`,
		f.Tenant, insp, trailerLeft, fmt.Sprintf(`["%s","%s"]`, f.Horse, f.Trailer))
	require.NoError(t, err)
	_, err = tx.Exec(ctx,
		`INSERT INTO app.inspection_absent_spare (tenant_id, inspection_id, vehicle_id, position_id)
		 VALUES ($1, $2, $3, $4)`, f.Tenant, insp, f.Trailer, f.SparePos)
	require.NoError(t, err)
	if onTimeline {
		_, err = tx.Exec(ctx,
			`INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source, inspection_id)
			 VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'UTC')::date, 412300, 'INSPECTION', $4)`,
			f.Tenant, f.Horse, submittedAt, insp)
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit(ctx))
	return insp
}

// plantInspectionAt is plantVoidableInspection at a chosen instant.
func plantInspectionAt(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, vehicleID, driverID, positionID uuid.UUID, at time.Time) uuid.UUID {
	t.Helper()
	tx, err := admin.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	var inspID, readingID uuid.UUID
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
		 VALUES ($1, $2, $3, $4, $5, $5, 1000) RETURNING id`,
		tenantID, vehicleID, driverID, uuid.New(), at).Scan(&inspID))
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		tenantID, inspID, vehicleID, positionID).Scan(&readingID))
	_, err = tx.Exec(ctx,
		`INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, tread_mm, position, orientation_known)
		 VALUES ($1, $2, 1, 10.0, 'CENTRE'::app.tread_position, true)`,
		tenantID, readingID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	return inspID
}

type unitInspectionBody struct {
	InspectionID string  `json:"inspectionId"`
	FleetNumber  string  `json:"fleetNumber"`
	State        string  `json:"state"`
	Latest       bool    `json:"latest"`
	VoidReason   *string `json:"voidReason"`
	VoidedBy     *string `json:"voidedBy"`
	VoidedAt     *string `json:"voidedAt"`
	StartedAt    string  `json:"startedAt"`
	SubmittedAt  string  `json:"submittedAt"`
	ReceivedAt   string  `json:"receivedAt"`
	AgeDays      int     `json:"ageDays"`
	Driver       struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	} `json:"driver"`
	AddressedHere bool `json:"addressedHere"`
	AddressedUnit struct {
		FleetNumber string  `json:"fleetNumber"`
		VehicleID   *string `json:"vehicleId"`
	} `json:"addressedUnit"`
	OdometerKm       *int64  `json:"odometerKm"`
	OdometerOnRecord *bool   `json:"odometerOnRecord"`
	Comment          *string `json:"comment"`
	DefectReport     *string `json:"defectReport"`
	PositionsRead    int     `json:"positionsRead"`
	WarningCount     int     `json:"warningCount"`
}

type unitInspectionPageBody struct {
	Inspections        []unitInspectionBody `json:"inspections"`
	NextAfter          *string              `json:"nextAfter"`
	LatestInspectionID *string              `json:"latestInspectionId"`
}

type inspectionReadingBody struct {
	ReadingID        string    `json:"readingId"`
	PositionID       string    `json:"positionId"`
	PositionCode     string    `json:"positionCode"`
	TyreID           *string   `json:"tyreId"`
	GoverningTreadMm *float64  `json:"governingTreadMm"`
	TreadsMm         []float64 `json:"treadsMm"`
	TreadAnatomy     []string  `json:"treadAnatomy"`
	OrientationKnown *bool     `json:"orientationKnown"`
	GoverningIndex   *int      `json:"governingIndex"`
	PressureKpa      *int      `json:"pressureKpa"`
	PressureBasis    string    `json:"pressureBasis"`
	TargetKpa        *int      `json:"targetKpa"`
}

type inspectionDetailBody struct {
	Inspection unitInspectionBody `json:"inspection"`
	Units      []struct {
		FleetNumber string  `json:"fleetNumber"`
		VehicleID   *string `json:"vehicleId"`
		InScope     bool    `json:"inScope"`
		Addressed   bool    `json:"addressed"`
	} `json:"units"`
	Readings     []inspectionReadingBody `json:"readings"`
	AbsentSpares []struct {
		PositionID   string `json:"positionId"`
		PositionCode string `json:"positionCode"`
	} `json:"absentSpares"`
	Warnings []struct {
		Code         string  `json:"code"`
		Source       string  `json:"source"`
		EnteredValue *string `json:"enteredValue"`
		Response     *string `json:"response"`
		RaisedAt     string  `json:"raisedAt"`
		PositionCode *string `json:"positionCode"`
	} `json:"warnings"`
}

func inspectionsPath(unit uuid.UUID) string {
	return "/api/vehicles/" + unit.String() + "/inspections"
}

func inspectionPath(unit, insp uuid.UUID) string {
	return inspectionsPath(unit) + "/" + insp.String()
}

func listUnitInspectionsAs(t *testing.T, h http.Handler, path string, tenant, user uuid.UUID) unitInspectionPageBody {
	t.Helper()
	rec := get(t, h, path, tenant.String(), user.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out unitInspectionPageBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func getUnitInspectionAs(t *testing.T, h http.Handler, unit, insp, tenant, user uuid.UUID) inspectionDetailBody {
	t.Helper()
	rec := get(t, h, inspectionPath(unit, insp), tenant.String(), user.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out inspectionDetailBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func TestUnitInspectionReadsAreViewFleetGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantTwoDepotRig(t, ctx, admin, "insp-gate")
	insp := plantRigInspection(t, ctx, admin, f, time.Now().Add(-24*time.Hour), true)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, path := range []string{inspectionsPath(f.Horse), inspectionPath(f.Horse, insp)} {
		rec := get(t, h, path, f.Tenant.String(), f.Driver.String())
		require.Equal(t, http.StatusForbidden, rec.Code, path)
		require.Equal(t, "forbidden", decodeRefusal(t, rec.Body.Bytes()).Code)

		rec = get(t, h, path, "", "")
		require.Equal(t, http.StatusUnauthorized, rec.Code, path)
	}
}

func TestUnitInspectionsRelayTheFixture(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tenant := uuid.MustParse(bacTenant)
	nomsa := seedID("controller1")
	link6, horse := seedID("veh2"), seedID("veh1")
	insp0, insp1 := seedID("insp0"), seedID("insp1")

	page := listUnitInspectionsAs(t, h, inspectionsPath(link6), tenant, nomsa)
	require.Len(t, page.Inspections, 2)
	require.Equal(t, insp1.String(), page.Inspections[0].InspectionID)
	require.Equal(t, insp0.String(), page.Inspections[1].InspectionID)
	require.NotNil(t, page.LatestInspectionID)
	require.Equal(t, insp1.String(), *page.LatestInspectionID)
	require.Nil(t, page.NextAfter)

	row := page.Inspections[0]
	require.True(t, row.Latest)
	require.False(t, page.Inspections[1].Latest)
	require.False(t, row.AddressedHere)
	require.Equal(t, "HORSE", row.AddressedUnit.FleetNumber)
	require.NotNil(t, row.AddressedUnit.VehicleID)
	require.Equal(t, horse.String(), *row.AddressedUnit.VehicleID)
	require.NotNil(t, row.OdometerKm)
	require.Equal(t, int64(412500), *row.OdometerKm)
	require.Equal(t, 8, row.PositionsRead)
	require.Equal(t, tenantDaysSince(t, ctx, admin, tenant, row.SubmittedAt), row.AgeDays)

	detail := getUnitInspectionAs(t, h, link6, insp1, tenant, nomsa)
	require.Len(t, detail.Readings, 8)
	codes := []string{}
	for _, r := range detail.Readings {
		codes = append(codes, r.PositionCode)
		var governing float64
		var treads []float64
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT governing_tread_mm::float8, measurements::float8[] FROM app.v_reading_detail WHERE reading_id = $1`,
			r.ReadingID).Scan(&governing, &treads))
		require.NotNil(t, r.GoverningTreadMm)
		require.Equal(t, governing, *r.GoverningTreadMm, r.PositionCode)
		require.Equal(t, treads, r.TreadsMm, r.PositionCode)
	}
	require.Equal(t, []string{"1", "2", "3", "4", "5", "6", "7", "8"}, codes)

	units := []string{}
	for _, u := range detail.Units {
		require.True(t, u.InScope, u.FleetNumber)
		require.NotNil(t, u.VehicleID, u.FleetNumber)
		units = append(units, u.FleetNumber)
	}
	require.Equal(t, []string{"HORSE", "LINK6", "LINK12"}, units)
	require.True(t, detail.Units[0].Addressed)
	require.NotNil(t, detail.Inspection.Comment)
	require.NotNil(t, detail.Inspection.DefectReport)
}

func TestUnitInspectionReadsAreDepotScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantTwoDepotRig(t, ctx, admin, "insp-depot")
	insp := plantRigInspection(t, ctx, admin, f, time.Now().Add(-24*time.Hour), true)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	t.Run("the controller reads the horse's id and odometer on the trailer's row (U249)", func(t *testing.T) {
		page := listUnitInspectionsAs(t, h, inspectionsPath(f.Trailer), f.Tenant, f.Controller)
		require.Len(t, page.Inspections, 1)
		row := page.Inspections[0]
		require.False(t, row.AddressedHere)
		require.NotNil(t, row.AddressedUnit.VehicleID)
		require.Equal(t, f.Horse.String(), *row.AddressedUnit.VehicleID)
		require.NotNil(t, row.OdometerKm)
		require.Equal(t, int64(412300), *row.OdometerKm)
		require.NotNil(t, row.OdometerOnRecord)
		require.True(t, *row.OdometerOnRecord)
		require.Equal(t, 2, row.PositionsRead)
		require.Equal(t, 1, row.WarningCount)
	})

	t.Run("the trailer's manager reads the horse by fleet number only", func(t *testing.T) {
		page := listUnitInspectionsAs(t, h, inspectionsPath(f.Trailer), f.Tenant, f.TrailerManager)
		require.Len(t, page.Inspections, 1)
		row := page.Inspections[0]
		require.Equal(t, f.HorseFleet, row.AddressedUnit.FleetNumber)
		require.Nil(t, row.AddressedUnit.VehicleID)
		require.Nil(t, row.OdometerKm)
		require.Nil(t, row.OdometerOnRecord)
	})

	t.Run("the trailer's manager reads the trailer's readings, warnings and spares, and no horse id", func(t *testing.T) {
		rec := get(t, h, inspectionPath(f.Trailer, insp), f.Tenant.String(), f.TrailerManager.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var d inspectionDetailBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &d))

		require.Len(t, d.Units, 2)
		require.Equal(t, f.HorseFleet, d.Units[0].FleetNumber)
		require.Nil(t, d.Units[0].VehicleID)
		require.False(t, d.Units[0].InScope)
		require.True(t, d.Units[0].Addressed)
		require.Equal(t, f.TrailerFleet, d.Units[1].FleetNumber)
		require.NotNil(t, d.Units[1].VehicleID)
		require.Equal(t, f.Trailer.String(), *d.Units[1].VehicleID)
		require.True(t, d.Units[1].InScope)

		require.Len(t, d.Warnings, 1)
		require.Equal(t, "FR-INS-037", d.Warnings[0].Code)
		require.NotNil(t, d.Warnings[0].PositionCode)
		require.Equal(t, "1L", *d.Warnings[0].PositionCode)
		require.NotNil(t, d.Warnings[0].EnteredValue)
		require.Equal(t, "640", *d.Warnings[0].EnteredValue)
		require.NotNil(t, d.Warnings[0].Response)
		require.Equal(t, "ACKNOWLEDGED", *d.Warnings[0].Response)

		require.Len(t, d.Readings, 2)
		var trailerReadings []string
		rows, err := admin.Query(ctx,
			`SELECT id::text FROM app.reading WHERE inspection_id = $1 AND vehicle_id = $2 ORDER BY position_id = $3 DESC`,
			insp, f.Trailer, f.LeftPos)
		require.NoError(t, err)
		for rows.Next() {
			var id string
			require.NoError(t, rows.Scan(&id))
			trailerReadings = append(trailerReadings, id)
		}
		require.NoError(t, rows.Err())
		left, right := d.Readings[0], d.Readings[1]
		require.Equal(t, "1L", left.PositionCode)
		require.Equal(t, "1R", right.PositionCode)
		require.Equal(t, trailerReadings, []string{left.ReadingID, right.ReadingID}, "the trailer's own readings, not the horse's 1L")
		require.NotNil(t, left.GoverningIndex)
		require.Equal(t, 1, *left.GoverningIndex)
		require.NotNil(t, left.TargetKpa)
		require.Equal(t, 800, *left.TargetKpa)
		require.Equal(t, "COLD", left.PressureBasis)
		require.Equal(t, []string{"OUTER", "CENTRE", "INNER"}, left.TreadAnatomy)

		// Review Focus 5: a reading with no tread carries [] and nulls.
		var raw struct {
			Readings []map[string]json.RawMessage `json:"readings"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
		require.Equal(t, "[]", string(raw.Readings[1]["treadsMm"]))
		require.Equal(t, "null", string(raw.Readings[1]["governingTreadMm"]))
		require.Equal(t, "null", string(raw.Readings[1]["governingIndex"]))
		require.Equal(t, "null", string(raw.Readings[1]["orientationKnown"]))

		require.Len(t, d.AbsentSpares, 1)
		require.Equal(t, f.SparePos.String(), d.AbsentSpares[0].PositionID)
		require.Equal(t, "SP1", d.AbsentSpares[0].PositionCode)
	})

	t.Run("the horse's manager reads the inspection-level warnings, and no ids in the rig report", func(t *testing.T) {
		d := getUnitInspectionAs(t, h, f.Horse, insp, f.Tenant, f.HorseManager)
		require.Len(t, d.Warnings, 2)
		byCode := map[string]*string{}
		for _, w := range d.Warnings {
			require.Nil(t, w.PositionCode, w.Code)
			byCode[w.Code] = w.EnteredValue
		}
		require.Contains(t, byCode, "FR-INS-033")
		require.NotNil(t, byCode["FR-INS-033"])
		require.Equal(t, "412300", *byCode["FR-INS-033"])
		require.Contains(t, byCode, "FR-INS-063")
		require.Nil(t, byCode["FR-INS-063"], "Review Focus 2: the rig report's unit ids never reach the wire")

		require.Len(t, d.Units, 2)
		require.Equal(t, f.TrailerFleet, d.Units[1].FleetNumber)
		require.Nil(t, d.Units[1].VehicleID)
		require.False(t, d.Units[1].InScope)
	})

	t.Run("the controller reads the horse's id and odometer on the trailer's page", func(t *testing.T) {
		d := getUnitInspectionAs(t, h, f.Trailer, insp, f.Tenant, f.Controller)
		require.NotNil(t, d.Inspection.AddressedUnit.VehicleID)
		require.Equal(t, f.Horse.String(), *d.Inspection.AddressedUnit.VehicleID)
		require.NotNil(t, d.Inspection.OdometerKm)
		require.Equal(t, int64(412300), *d.Inspection.OdometerKm)
	})
}

func TestUnitInspectionReadsAnswerNotFound(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantTwoDepotRig(t, ctx, admin, "insp-404")
	insp := plantRigInspection(t, ctx, admin, f, time.Now().Add(-24*time.Hour), false)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	notFound := func(t *testing.T, path string, tenant, user uuid.UUID) {
		t.Helper()
		rec := get(t, h, path, tenant.String(), user.String())
		require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
		require.Equal(t, "not_found", decodeRefusal(t, rec.Body.Bytes()).Code)
	}
	notFound(t, inspectionsPath(f.Horse), f.Tenant, f.TrailerManager)
	notFound(t, inspectionPath(f.Horse, insp), f.Tenant, f.TrailerManager)
	notFound(t, inspectionPath(f.Outsider, insp), f.Tenant, f.Controller)
	notFound(t, inspectionPath(f.Trailer, uuid.New()), f.Tenant, f.Controller)

	other := plantTwoDepotRig(t, ctx, admin, "insp-404-b")
	notFound(t, inspectionsPath(f.Trailer), other.Tenant, other.Controller)

	for _, path := range []string{
		"/api/vehicles/not-a-uuid/inspections",
		"/api/vehicles/not-a-uuid/inspections/" + insp.String(),
		inspectionsPath(f.Trailer) + "/not-a-uuid",
	} {
		rec := get(t, h, path, f.Tenant.String(), f.Controller.String())
		require.Equal(t, http.StatusBadRequest, rec.Code, path)
		require.Equal(t, "bad_request", decodeRefusal(t, rec.Body.Bytes()).Code)
	}

	rec := get(t, h, inspectionsPath(f.Outsider), f.Tenant.String(), f.Controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"inspections":[],"nextAfter":null,"latestInspectionId":null}`, rec.Body.String())
}

func TestVoidedInspectionStaysListedAndReadable(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantTwoDepotRig(t, ctx, admin, "insp-voided")
	insp := plantRigInspection(t, ctx, admin, f, time.Now().Add(-24*time.Hour), false)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, voidPath(insp.String()), f.Tenant.String(), f.Controller.String(), `{"reason":"wrong rig"}`)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	page := listUnitInspectionsAs(t, h, inspectionsPath(f.Trailer), f.Tenant, f.Controller)
	require.Len(t, page.Inspections, 1)
	row := page.Inspections[0]
	require.Equal(t, "VOIDED", row.State)
	require.False(t, row.Latest)
	require.NotNil(t, row.VoidReason)
	require.Equal(t, "wrong rig", *row.VoidReason)
	require.NotNil(t, row.VoidedBy)
	require.Equal(t, displayNameOf(t, ctx, admin, f.Controller), *row.VoidedBy)
	require.NotNil(t, row.VoidedAt)
	require.Nil(t, page.LatestInspectionID)

	d := getUnitInspectionAs(t, h, f.Trailer, insp, f.Tenant, f.Controller)
	require.Len(t, d.Readings, 2)
	require.Equal(t, "VOIDED", d.Inspection.State)
}

// Review Focus 1: the latest inspection is named whatever page holds it.
func TestUnitInspectionListPagesAndNamesTheLatestBeyondThePage(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenant, unit, other, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "insp-page")
	driver := plantUser(t, ctx, admin, tenant, auth.RoleDriver)
	controller := plantUser(t, ctx, admin, tenant, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	base := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	ids := make([]uuid.UUID, 21)
	for i := range ids {
		ids[i] = plantInspectionAt(t, ctx, admin, tenant, unit, driver, leftPos, base.Add(time.Duration(i)*time.Minute))
	}
	_, err := admin.Exec(ctx,
		`UPDATE app.inspection SET state = 'VOIDED', void_reason = 'page test' WHERE id = ANY ($1) AND id <> $2`,
		ids, ids[0])
	require.NoError(t, err)

	first := listUnitInspectionsAs(t, h, inspectionsPath(unit), tenant, controller)
	require.Len(t, first.Inspections, 20)
	seen := map[string]bool{}
	for i, row := range first.Inspections {
		require.Equal(t, ids[20-i].String(), row.InspectionID, "newest first")
		require.False(t, row.Latest)
		seen[row.InspectionID] = true
	}
	require.NotNil(t, first.NextAfter)
	require.Equal(t, ids[1].String(), *first.NextAfter)
	require.NotNil(t, first.LatestInspectionID)
	require.Equal(t, ids[0].String(), *first.LatestInspectionID)

	second := listUnitInspectionsAs(t, h, inspectionsPath(unit)+"?after="+*first.NextAfter, tenant, controller)
	require.Len(t, second.Inspections, 1)
	require.Equal(t, ids[0].String(), second.Inspections[0].InspectionID)
	require.True(t, second.Inspections[0].Latest)
	require.Nil(t, second.NextAfter)
	require.False(t, seen[second.Inspections[0].InspectionID], "no inspection is on both pages")

	elsewhere := plantInspectionAt(t, ctx, admin, tenant, other, driver, leftPos, base)
	rec := get(t, h, inspectionsPath(unit)+"?after="+elsewhere.String(), tenant.String(), controller.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	body := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "invalid_submission", body.Code)
	require.Equal(t, "after names no inspection of this unit", body.Message)

	rec = get(t, h, inspectionsPath(unit)+"?after=nope", tenant.String(), controller.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Equal(t, "after must be a uuid", decodeRefusal(t, rec.Body.Bytes()).Message)
}
