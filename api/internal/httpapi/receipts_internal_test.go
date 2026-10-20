package httpapi

import (
	"testing"

	"github.com/google/uuid"

	req "github.com/stretchr/testify/require" // aliased: see ratelimit_test.go
)

// Every role that reaches the receipt routes (ManageAssets) also holds
// ViewValuation, so the hidden branch runs only here, as
// TestTyreJSONForProjectsMoneyByCapability's does (FR-AUT-005a).
func TestEstimateJSONForHidesMoney(t *testing.T) {
	row := &priceEstimateRow{typicalPrice: "4319.91", effectiveFrom: "2026-06-01", brandSpecific: true}

	shown := estimateJSONFor(row, true)
	req.NotNil(t, shown)
	req.Equal(t, priceEstimateJSON{TypicalPrice: "4319.91", EffectiveFrom: "2026-06-01", BrandSpecific: true}, *shown)
	req.Nil(t, estimateJSONFor(row, false), "an estimate is money, so a hidden one is no estimate")
	req.Nil(t, estimateJSONFor(nil, true), "no list entry is no estimate")
}

func TestOpenReceiptJSONForHidesTheUnitPrice(t *testing.T) {
	price := "4319.91"
	row := openReceiptRow{id: uuid.New(), priceState: "ESTIMATED", quantity: 2, inFleet: 2,
		displayCodes: []string{"A-1", "A-2"}, unitPrice: &price}

	shown := openReceiptJSONFor(row, true)
	req.NotNil(t, shown.UnitPrice)
	req.Equal(t, price, *shown.UnitPrice)
	hidden := openReceiptJSONFor(row, false)
	req.Nil(t, hidden.UnitPrice)
	req.Equal(t, row.displayCodes, hidden.DisplayCodes, "the projection hides money only")
}
