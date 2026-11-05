package httpapi

import (
	"encoding/json"
	"reflect"
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

// A path the walk cannot resolve answers no name, so the caller gets the
// generic refusal rather than a guess.
func TestTypeErrorFieldLeavesAnUnresolvablePathUnnamed(t *testing.T) {
	err := &json.UnmarshalTypeError{Field: "nosuch.x", Type: reflect.TypeOf(0)}
	_, named := typeErrorField(err, &probeBody{})
	req.False(t, named)
}

// Two names that differ only by case: the decoder writes B.
type probeCollide struct {
	A int    `json:"Name"`
	B string `json:"name"`
}

// The decoder writes the shallower X; the embedded one comes first.
type probeShadowInner struct {
	X int `json:"x"`
}

type probeShadow struct {
	probeShadowInner
	X string `json:"x"`
}

// The decoder's exact-name pass reaches into the embedded struct before any
// case-insensitive match outside it.
type probeDeepInner struct {
	N string `json:"name"`
}

type probeDeepFirst struct {
	probeDeepInner
	M int `json:"nAme"`
}

type probeDeepLast struct {
	M int `json:"nAme"`
	probeDeepInner
}

// A type that embeds itself would walk without end.
type probeSelf struct {
	*probeSelf
	X int `json:"x"`
}

// Fold-equal names of one type, which the type check cannot tell apart.
type probeSameType struct {
	A int `json:"Name"`
	B int `json:"name"`
}

type probeSameShadowInner struct {
	Y int `json:"y"`
}

type probeSameShadow struct {
	probeSameShadowInner
	Y int `json:"Y"`
}

// A map ends the walk, so no type is left to check.
type probeMapPair struct {
	A map[string]int    `json:"Name"`
	B map[string]string `json:"name"`
}

// encoding/json reads a tagged embedded struct as a named field, whatever its
// type's export.
type probeUnexpInner struct {
	Kpa int `json:"kpa"`
}

type probeUnexpAlone struct {
	probeUnexpInner `json:"inner"`
}

// The decoder cannot set an embedded pointer to an unexported struct, and
// reports the outer struct as the type it failed on.
type probeUnexpPtr struct {
	*probeUnexpInner
}

type probeUnexpPair struct {
	probeUnexpInner `json:"inner"`
	Other           probeUnexpInner `json:"INNER"`
}

// Shapes where the decoder's choice between fold-equal fields (an exact name
// first, a shallower field first) differs from a first match in declaration
// order. Each names the decoder's field or nothing.
func TestTypeErrorFieldNamesNoOtherFieldInTheseShapes(t *testing.T) {
	for _, tt := range []struct {
		name  string
		into  any
		body  string
		field string
		named bool
	}{
		{"two names that fold equal, of two types", &probeCollide{}, `{"name":5}`, "", false},
		{"two names that fold equal, of one type", &probeSameType{}, `{"name":"s"}`, "", false},
		{"an embedded field the decoder skips, of another type", &probeShadow{}, `{"x":true}`, "", false},
		{"an embedded field the decoder skips, of the same type", &probeSameShadow{}, `{"Y":"x"}`, "", false},
		{"an exact name inside an embedded struct, first", &probeDeepFirst{}, `{"name":5}`, "", false},
		{"an exact name inside an embedded struct, last", &probeDeepLast{}, `{"name":5}`, "", false},
		{"two maps whose names fold equal", &probeMapPair{}, `{"name":{"k":5}}`, "", false},
		{"a tagged embedded struct of an unexported type", &probeUnexpAlone{}, `{"inner":{"kpa":"x"}}`, "inner.kpa", true},
		{"a tagged unexported embed beside a fold-equal field", &probeUnexpPair{}, `{"inner":{"kpa":"x"}}`, "", false},
		{"an embedded pointer to an unexported struct", &probeUnexpPtr{}, `{"kpa":5}`, "", false},
		{"a type that embeds itself", &probeSelf{probeSelf: &probeSelf{}}, `{"x":"s"}`, "x", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := json.Unmarshal([]byte(tt.body), tt.into)
			req.Error(t, err)
			field, named := typeErrorField(err, tt.into)
			req.Equal(t, tt.named, named)
			req.Equal(t, tt.field, field)
		})
	}
}

// Go 1.27 writes every element's index into the path, so a slice segment
// that is not one resolves nothing, and a slice of itself cannot loop.
type probeLoop []probeLoop

func TestTypeErrorFieldStopsOnANonIndexSliceSegment(t *testing.T) {
	err := &json.UnmarshalTypeError{Field: "a", Type: reflect.TypeOf(0)}
	_, named := typeErrorField(err, &probeLoop{})
	req.False(t, named)
}
