package httpapi

import (
	"strings"
	"testing"

	// Aliased: this file shares package httpapi with httpapi.go's own
	// capability-check function named require, so the unaliased import would
	// shadow it (refusal_internal_test.go's own convention).
	req "github.com/stretchr/testify/require"
)

// decodeFitWarnings' doc comment (fitments.go) explains why two of these four
// cases cannot be reached by driving the handler: app.fit_tyre answers
// '[]'::jsonb, so nothing this side can make its warnings column arrive as a
// SQL NULL or as a jsonb null literal. This is the only place those arms run,
// and what each asserts is the same property — the caller is handed a list it
// can take len() of, never a nil the screens would read as an absent one.
func TestDecodeFitWarningsNeverAnswersNil(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  []byte
		want []fitWarningJSON
	}{
		// A SQL NULL scans as a nil []byte. json.Unmarshal refuses it with
		// "unexpected end of JSON input", so without this arm a fit that
		// landed would answer 500.
		{"a SQL NULL", nil, []fitWarningJSON{}},
		{"a jsonb null literal", []byte(`null`), []fitWarningJSON{}},
		{"the empty array app.fit_tyre actually answers", []byte(`[]`), []fitWarningJSON{}},
		{
			"warnings forwarded verbatim",
			[]byte(`[{"code":"FIT_RETREAD_ON_STEER","message":"a retread on a steer axle"}]`),
			[]fitWarningJSON{{Code: "FIT_RETREAD_ON_STEER", Message: "a retread on a steer axle"}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := decodeFitWarnings(tc.raw)
			req.NoError(t, err)
			req.NotNil(t, got, "an empty list, never a nil one")
			req.Equal(t, tc.want, got)
		})
	}

	// The control: a column that is neither absent nor a list is still an
	// error, so the three arms above are a reading of the data rather than a
	// blanket swallow.
	got, err := decodeFitWarnings([]byte(`{"code":"NOT_A_LIST"}`))
	req.Error(t, err)
	req.Nil(t, got)
}

// app.rotate_tyres reads a move's destination with COALESCE((m->>'to_vehicle_id')::uuid,
// p_vehicle), and ->> answers SQL NULL for both an absent key and a JSON null,
// so no request driven through the handler can tell the two apart. The shape
// still matters — the function's default is the one place the anchor is
// filled in (U15, U17) — and this is the only place able to assert it.
func TestRotatePayloadNamesADestinationOnlyWhenTheCallerDid(t *testing.T) {
	anchored := "11111111-1111-4111-8111-111111111111"
	crossing := "22222222-2222-4222-8222-222222222222"
	position := "33333333-3333-4333-8333-333333333333"

	moves, err := rotateRequest{Moves: []rotateMove{
		{TyreID: anchored, ToPositionID: position, TreadMm: "8.0"},
		{TyreID: anchored, ToVehicleID: &crossing, ToPositionID: position, TreadMm: "8.0"},
	}}.payload()
	req.NoError(t, err)
	req.Len(t, moves, 2)

	_, present := moves[0]["to_vehicle_id"]
	req.False(t, present, "a move naming no destination carries no key, not a null")
	req.Equal(t, crossing, moves[1]["to_vehicle_id"])

	// An uppercase destination reaches SQL in the casing Postgres compares
	// with, for odometerPayload's reason.
	upper := "22222222-2222-4222-8222-22222222222A"
	crossed, err := rotateRequest{Moves: []rotateMove{
		{TyreID: anchored, ToVehicleID: &upper, ToPositionID: position, TreadMm: "8.0"},
	}}.payload()
	req.NoError(t, err)
	req.Equal(t, strings.ToLower(upper), crossed[0]["to_vehicle_id"])
}

// A rotation that gives no reading must reach app.rotate_tyres as a SQL NULL,
// which is a nil map here and no bytes at the bind: `{}` and the jsonb literal
// `null` are both objects the function has something to say about, and only
// one of the three means "this rotation supplied no odometer".
func TestRotateOdometerPayloadDistinguishesNoneFromEmpty(t *testing.T) {
	anchor := "11111111-1111-4111-8111-111111111111"
	// Hex letters, not digits: an all-numeric uuid is its own upper case, so
	// the two keys below would be one key in the map and the collision the
	// last case exists for could not arise.
	other := "2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e"

	none, err := rotateRequest{}.odometerPayload(anchor)
	req.NoError(t, err)
	req.Nil(t, none, "a body naming no odometer gives the function nothing to read")

	empty, err := rotateRequest{Odometers: map[string]int64{}}.odometerPayload(anchor)
	req.NoError(t, err)
	req.NotNil(t, empty, "a body naming an empty set asked for one")
	req.Empty(t, empty)

	lone, err := rotateRequest{Odometer: int64Ref(1500)}.odometerPayload(anchor)
	req.NoError(t, err)
	req.Equal(t, map[string]int64{anchor: 1500}, lone)

	// Both spellings of one unit collide only after this side canonicalises,
	// so the refusal is the only thing standing between a caller and a
	// reading chosen by map iteration order.
	_, err = rotateRequest{Odometers: map[string]int64{
		other: 1500, strings.ToUpper(other): 1600,
	}}.odometerPayload(anchor)
	req.Error(t, err)
	req.Contains(t, err.Error(), "odometers.")
}

func int64Ref(v int64) *int64 { return &v }
