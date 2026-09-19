package httpapi

import (
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	// Aliased: this file shares package httpapi with the capability-check
	// function named require, so the unaliased import would shadow it
	// (docs/lessons.md, 2026-08-28).
	req "github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
)

func TestUnitScopeChoosesTheRelationByScopeNotRole(t *testing.T) {
	controller := auth.Actor{Role: auth.RoleController}
	technician := auth.Actor{Role: auth.RoleTechnician}
	req.Contains(t, unitScope(controller, "e.vehicle_id"), "FROM app.vehicle sv")
	req.Contains(t, unitScope(technician, "e.vehicle_id"), "FROM app.v_depot_vehicle sv")
	// Pins the always-$1 depot filter unitScope's doc comment states.
	req.Contains(t, unitScope(technician, "e.vehicle_id"), "$1::uuid IS NULL OR")
}

func TestAggregateScopeReadsTenantRowOrOwnDepotRows(t *testing.T) {
	controller := auth.Actor{Role: auth.RoleController}
	manager := auth.Actor{Role: auth.RoleDepotManager}

	byID := aggregateScope(controller, depotByID)
	req.Contains(t, byID, "v.level = 'TENANT'")
	req.Contains(t, byID, "v.depot_id = $1::uuid")

	own := aggregateScope(manager, depotByID)
	req.NotContains(t, own, "'TENANT'")
	req.Contains(t, own, "v.depot_id IN (SELECT depot_id FROM app.v_actor_depot)")

	named := aggregateScope(manager, depotByName)
	req.Contains(t, named, "v.key_name IN (SELECT d.name FROM app.depot d JOIN app.v_actor_depot ad ON ad.depot_id = d.id)")
	req.True(t, strings.Contains(aggregateScope(controller, depotByName), "(SELECT name FROM app.depot WHERE id = $1)"))
}

func TestScopeForLabelsWhatWasSummed(t *testing.T) {
	d := uuid.New()
	controller := auth.Actor{Role: auth.RoleController}
	manager := auth.Actor{Role: auth.RoleDepotManager, DepotIDs: []uuid.UUID{uuid.New(), uuid.New()}}
	req.Equal(t, scopeJSON{Level: "TENANT", DepotCount: 0, Depot: nil}, scopeFor(controller, nil))
	req.Equal(t, scopeJSON{Level: "DEPOT", DepotCount: 1, Depot: &d}, scopeFor(controller, &d))
	req.Equal(t, scopeJSON{Level: "DEPOTS", DepotCount: 2, Depot: nil}, scopeFor(manager, nil))
	req.Equal(t, scopeJSON{Level: "DEPOT", DepotCount: 1, Depot: &d}, scopeFor(manager, &d))
}

func TestQueryParamsRefuseWhatTheyCannotBind(t *testing.T) {
	q := url.Values{"from": {"2026-08-01"}, "bad": {"01/08/2026"}, "n": {"7"}, "zero": {"0"}, "level": {"DEPOT"}, "flag": {"true"}}
	from, err := dateParam(q, "from")
	req.NoError(t, err)
	req.Equal(t, "2026-08-01", *from)
	_, err = dateParam(q, "bad")
	req.EqualError(t, err, "bad must be a date as YYYY-MM-DD")
	absent, err := dateParam(q, "missing")
	req.NoError(t, err)
	req.Nil(t, absent)

	n, err := positiveIntParam(q, "n")
	req.NoError(t, err)
	req.Equal(t, 7, *n)
	_, err = positiveIntParam(q, "zero")
	req.EqualError(t, err, "zero must be a whole number of at least 1")

	level, err := oneOfParam(q, "level", "TENANT", "DEPOT")
	req.NoError(t, err)
	req.Equal(t, "DEPOT", *level)
	_, err = oneOfParam(q, "level", "TENANT")
	req.EqualError(t, err, "level must be one of TENANT")

	req.True(t, boolParam(q, "flag"))
	req.False(t, boolParam(q, "missing"))
}

func TestDepotRowsScopeListsOnlyReachableDepots(t *testing.T) {
	controller := auth.Actor{Role: auth.RoleController}
	technician := auth.Actor{Role: auth.RoleTechnician}
	req.Contains(t, depotRowsScope(controller, depotByName), "v.level = 'DEPOT'")
	req.NotContains(t, depotRowsScope(controller, depotByName), "v_actor_depot")
	req.Contains(t, depotRowsScope(technician, depotByName), "v.key_name IN (SELECT d.name FROM app.depot d JOIN app.v_actor_depot ad ON ad.depot_id = d.id)")
}
