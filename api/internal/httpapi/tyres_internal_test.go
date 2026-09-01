package httpapi

import (
	"testing"

	"github.com/google/uuid"

	// Aliased: this file shares package httpapi with httpapi.go's own
	// capability-check function named require, so the unaliased import would
	// shadow it (refusal_internal_test.go's own convention).
	req "github.com/stretchr/testify/require"
)

// Every role that can reach listTyres today holds ManageAssets, and every
// role holding ManageAssets also holds ViewValuation (auth.go's capability
// table), so canSeeMoney=false never fires by driving the handler — this
// unit test is the only place the hidden branch runs. FR-AUT-005a's
// projection exists anyway: it is what a role that gains ManageAssets
// without ViewValuation would rely on, and this test is what keeps it
// working the day such a role is added.
func TestTyreJSONForProjectsMoneyByCapability(t *testing.T) {
	price, rate, casing := "1500.00", "250.0000", "800.00"
	row := tyreRow{
		id:            uuid.New(),
		displayCode:   "UNIT-1",
		state:         "IN_STOCK",
		status:        "NEW",
		retreadCount:  0,
		purchasePrice: &price,
		randPerMm:     &rate,
		casingValue:   &casing,
	}

	withMoney := tyreJSONFor(row, true)
	req.NotNil(t, withMoney.PurchasePrice)
	req.Equal(t, price, *withMoney.PurchasePrice)
	req.NotNil(t, withMoney.RandPerMm)
	req.Equal(t, rate, *withMoney.RandPerMm)
	req.NotNil(t, withMoney.CasingValue)
	req.Equal(t, casing, *withMoney.CasingValue)

	withoutMoney := tyreJSONFor(row, false)
	req.Nil(t, withoutMoney.PurchasePrice)
	req.Nil(t, withoutMoney.RandPerMm)
	req.Nil(t, withoutMoney.CasingValue)
	// The projection hides money only — everything else on the row survives.
	req.Equal(t, row.displayCode, withoutMoney.DisplayCode)
	req.Equal(t, row.id.String(), withoutMoney.ID)
	req.Equal(t, row.state, withoutMoney.State)
	req.Equal(t, row.status, withoutMoney.Status)
}
