package httpapi

import (
	"github.com/google/uuid"

	"tyreplatform/api/internal/auth"
)

// The analytics half of ADR-0006 option C, beside unitSource: the scope
// predicate is defined once in SQL (app.v_depot_vehicle, app.v_actor_depot)
// and every handler composes it. See api/CLAUDE.md, "Analytics reads".
//
// Operating-group filtering (FR-DSH-011) is not here: vehicle.operating_group_id
// is live but no surface assigns it and the fixture has no group (TYRE-109).

// unitScope narrows a row keyed by vehicle: the unit must be in the actor's
// source relation, and ?depot= must be its home depot when given. The depot
// filter is always $1 so a forgotten placeholder fails at query time rather
// than widening a read.
func unitScope(a auth.Actor, vehicleCol string) string {
	return ` AND EXISTS (SELECT 1 FROM ` + unitSource(a) + ` sv WHERE sv.id = ` + vehicleCol + `)` +
		` AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM app.vehicle dv WHERE dv.id = ` + vehicleCol + ` AND dv.home_depot_id = $1))`
}

// depotKey says how an aggregate view names its DEPOT rows.
type depotKey int

const (
	// depotByID: the view carries depot_id (v_casing_value_at_risk).
	depotByID depotKey = iota
	// depotByName: the view groups by the depot's name in key_name
	// (v_estate_valuation, v_tread_distribution). app.depot's UNIQUE
	// (tenant_id, name) is what makes the join through the name exact.
	depotByName
)

// aggregateScope picks the rows of an aggregate view, aliased v, that an
// actor may read (spec U25): a ScopeTenant actor reads the TENANT row, or
// the one DEPOT row ?depot= names; a ScopeDepot actor reads the DEPOT rows
// of its own depots and the caller sums them in the same statement. The sum
// of the DEPOT rows is what the TENANT row already is, so this composes
// rather than recomputes. A ScopeDepot actor naming a depot outside its own
// reads nothing, which keeps "not yours" and "does not exist" the same
// answer (ADR-0011).
func aggregateScope(a auth.Actor, k depotKey) string {
	col, own, named := "v.depot_id", "(SELECT depot_id FROM app.v_actor_depot)", "$1::uuid"
	if k == depotByName {
		col = "v.key_name"
		own = "(SELECT d.name FROM app.depot d JOIN app.v_actor_depot ad ON ad.depot_id = d.id)"
		named = "(SELECT name FROM app.depot WHERE id = $1)"
	}
	if a.Scope() == auth.ScopeTenant {
		return ` AND (($1::uuid IS NULL AND v.level = 'TENANT') OR ($1::uuid IS NOT NULL AND v.level = 'DEPOT' AND ` + col + ` = ` + named + `))`
	}
	return ` AND v.level = 'DEPOT' AND ` + col + ` IN ` + own + ` AND ($1::uuid IS NULL OR ` + col + ` = ` + named + `)`
}

// scopeJSON tells the client what a figure covers, so "across your N depots"
// is a label the page renders from the response rather than a guess from the
// actor's role (spec U25).
type scopeJSON struct {
	// TENANT for the whole tenant, DEPOT for one named depot, DEPOTS for a
	// depot-scoped actor's whole set.
	Level      string     `json:"level"`
	DepotCount int        `json:"depotCount"`
	Depot      *uuid.UUID `json:"depot"`
}

func scopeFor(a auth.Actor, depot *uuid.UUID) scopeJSON {
	switch {
	case depot != nil:
		return scopeJSON{Level: "DEPOT", DepotCount: 1, Depot: depot}
	case a.Scope() == auth.ScopeTenant:
		return scopeJSON{Level: "TENANT"}
	default:
		return scopeJSON{Level: "DEPOTS", DepotCount: len(a.DepotIDs)}
	}
}

// depotRowsScope lists an aggregate view's DEPOT rows, one per depot, for a
// level=DEPOT read: every depot for a ScopeTenant actor, the actor's own for
// ScopeDepot, and ?depot= narrows either to one. aggregateScope is the summed
// reading; this is the itemised one.
func depotRowsScope(a auth.Actor, k depotKey) string {
	col, own, named := "v.depot_id", "(SELECT depot_id FROM app.v_actor_depot)", "$1::uuid"
	if k == depotByName {
		col = "v.key_name"
		own = "(SELECT d.name FROM app.depot d JOIN app.v_actor_depot ad ON ad.depot_id = d.id)"
		named = "(SELECT name FROM app.depot WHERE id = $1)"
	}
	sql := ` AND v.level = 'DEPOT' AND ($1::uuid IS NULL OR ` + col + ` = ` + named + `)`
	if a.Scope() != auth.ScopeTenant {
		sql += ` AND ` + col + ` IN ` + own
	}
	return sql
}
