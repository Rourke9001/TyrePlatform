package httpapi

import (
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
