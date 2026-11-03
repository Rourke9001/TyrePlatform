package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	req "github.com/stretchr/testify/require" // aliased: see ratelimit_test.go
)

type probeMove struct {
	TreadMm string `json:"treadMm"`
}

type probeInner struct {
	Kpa int `json:"kpa"`
}

type probeEmbedded struct {
	Note int `json:"note"`
}

type probeBody struct {
	probeEmbedded
	Odometer  *int                  `json:"odometer"`
	Odometers map[string]int        `json:"odometers"`
	Moves     []probeMove           `json:"moves"`
	Nested    probeInner            `json:"nested"`
	Ptr       *probeInner           `json:"ptr"`
	ByKey     map[string]probeInner `json:"byKey"`
	Untagged  int
}

// ADR-0012: a wrong-type refusal names the field from this package's json
// tags and never echoes caller text. Go 1.27's UnmarshalTypeError.Field
// carries the caller's map keys and slice indexes (TYRE-379), so the name is
// rebuilt from the destination type.
func TestTypeErrorFieldNamesOnlyTags(t *testing.T) {
	longKey := strings.Repeat("k", 5000)
	for _, tt := range []struct {
		body string
		want string
	}{
		{`{"odometer":"x"}`, "odometer"},
		{`{"odometers":{"a.b.c":"x"}}`, "odometers"},
		{`{"odometers":{"` + longKey + `":"x"}}`, "odometers"},
		{`{"moves":[{"treadMm":"1"},{"treadMm":5}]}`, "moves.treadMm"},
		{`{"moves":"x"}`, "moves"},
		{`{"nested":{"kpa":"x"}}`, "nested.kpa"},
		{`{"ptr":{"kpa":"x"}}`, "ptr.kpa"},
		{`{"byKey":{"key.with.kpa":{"kpa":"x"}}}`, "byKey"},
		{`{"note":"x"}`, "note"},
		{`{"NESTED":{"KPA":"x"}}`, "nested.kpa"},
		{`{"Untagged":"x"}`, "Untagged"},
	} {
		t.Run(tt.body[:min(len(tt.body), 40)], func(t *testing.T) {
			var into probeBody
			err := json.Unmarshal([]byte(tt.body), &into)
			req.Error(t, err)
			field, named := typeErrorField(err, &into)
			req.True(t, named)
			req.Equal(t, tt.want, field)
		})
	}
}

func TestTypeErrorFieldLeavesOtherErrorsUnnamed(t *testing.T) {
	var into probeBody
	err := json.Unmarshal([]byte(`{"odometer":`), &into)
	req.Error(t, err)
	_, named := typeErrorField(err, &into)
	req.False(t, named)
}
