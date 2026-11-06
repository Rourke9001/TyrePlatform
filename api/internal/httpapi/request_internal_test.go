package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	Addr      uintptr               `json:"addr"`
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
			field, named := typeErrorField(typeErrorOf(t, err), &into)
			req.True(t, named)
			req.Equal(t, tt.want, field)
		})
	}
}

// typeErrorOf unwraps err the way typeErrorMessage does before it calls
// typeErrorField.
func typeErrorOf(t *testing.T, err error) *json.UnmarshalTypeError {
	t.Helper()
	var typeErr *json.UnmarshalTypeError
	req.ErrorAs(t, err, &typeErr)
	return typeErr
}

func TestTypeErrorMessageLeavesOtherErrorsUnnamed(t *testing.T) {
	var into probeBody
	err := json.Unmarshal([]byte(`{"odometer":`), &into)
	req.Error(t, err)
	_, named := typeErrorMessage(err, &into)
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

// encoding/json reads a tagged embedded struct as a named field, whether or
// not its type is exported.
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

// encoding/json skips a field only when its whole tag is "-"; "-," names it
// "-".
type probeDashComma struct {
	//lint:ignore SA5008 the tag is the shape under test
	D int `json:"-,"`
}

// One name and one type at two depths: the decoder takes the outer field.
type probeSameNameShadow struct {
	probeSameShadowInner
	Y int `json:"y"`
}

// Each of these shapes names the field the decoder failed on, or nothing.
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
		{"an embedded field the decoder skips, of the same name and type", &probeSameNameShadow{}, `{"y":"x"}`, "", false},
		{"an exact name inside an embedded struct, first", &probeDeepFirst{}, `{"name":5}`, "", false},
		{"an exact name inside an embedded struct, last", &probeDeepLast{}, `{"name":5}`, "", false},
		{"two maps whose names fold equal", &probeMapPair{}, `{"name":{"k":5}}`, "", false},
		{"a tagged embedded struct of an unexported type", &probeUnexpAlone{}, `{"inner":{"kpa":"x"}}`, "inner.kpa", true},
		{"a tagged unexported embed beside a fold-equal field", &probeUnexpPair{}, `{"inner":{"kpa":"x"}}`, "", false},
		{"an embedded pointer to an unexported struct", &probeUnexpPtr{}, `{"kpa":5}`, "", false},
		{"a type that embeds itself", &probeSelf{probeSelf: &probeSelf{}}, `{"x":"s"}`, "x", true},
		{"a field tagged -,", &probeDashComma{}, `{"-":"s"}`, "-", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := json.Unmarshal([]byte(tt.body), tt.into)
			req.Error(t, err)
			field, named := typeErrorField(typeErrorOf(t, err), tt.into)
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

// decodeJSONRefusal sends body through decodeJSON, requires a 400
// malformed_json refusal, and answers its message.
func decodeJSONRefusal(t *testing.T, body string, into any) string {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.False(t, decodeJSON(rec, r, into))
	req.Equal(t, http.StatusBadRequest, rec.Code)
	var refusal errorBody
	req.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal))
	req.Equal(t, "malformed_json", refusal.Code)
	return refusal.Message
}

// A number the field's type refuses, past its range or in a form the type does
// not take, is still a number, so the refusal does not call it a value of the
// wrong type (TYRE-379). Both wordings say what the field holds, which reads
// true of a map or a slice as well as a scalar.
func TestDecodeJSONWordsAValueItCannotStore(t *testing.T) {
	for _, tt := range []struct {
		body string
		want string
	}{
		{`{"odometer":1e400}`, "odometer holds a number this field does not accept"},
		{`{"odometer":99999999999999999999}`, "odometer holds a number this field does not accept"},
		{`{"odometer":1.5}`, "odometer holds a number this field does not accept"},
		{`{"odometer":"1500"}`, "odometer holds a value of the wrong type"},
		{`{"moves":[{"treadMm":5}]}`, "moves.treadMm holds a value of the wrong type"},
		{`{"odometer":1e3}`, "odometer holds a number this field does not accept"},
		{`{"odometer":5.0}`, "odometer holds a number this field does not accept"},
		{`{"odometers":{"FL":1.5}}`, "odometers holds a number this field does not accept"},
		{`{"addr":-1}`, "addr holds a number this field does not accept"},
		{`{"odometers":{"FL":"1500"}}`, "odometers holds a value of the wrong type"},
		{`{"moves":"x"}`, "moves holds a value of the wrong type"},
	} {
		t.Run(tt.body, func(t *testing.T) {
			req.Equal(t, tt.want, decodeJSONRefusal(t, tt.body, &probeBody{}))
		})
	}
}

// Three shapes take text and still get one of typeErrorMessage's two
// messages for text they cannot read: a field tagged ,string, a []byte given
// text that is not base64, and a map keyed by a number. In three of the rows
// below the message misreads the text, calling "abc" a number twice and "!!"
// a value of the wrong type.
type probeTextShapes struct {
	Count  int           `json:"count,string"`
	Ratio  float32       `json:"ratio,string"`
	Blob   []byte        `json:"blob"`
	ByNum  map[int]int   `json:"byNum"`
	ByByte map[uint8]int `json:"byByte"`
}

func TestDecodeJSONWordsTextTheseShapesCannotRead(t *testing.T) {
	for _, tt := range []struct {
		body string
		want string
	}{
		{`{"count":"abc"}`, "count holds a number this field does not accept"},
		{`{"ratio":"1e39"}`, "ratio holds a number this field does not accept"},
		{`{"blob":"!!"}`, "blob holds a value of the wrong type"},
		{`{"byNum":{"abc":1}}`, "byNum holds a number this field does not accept"},
		{`{"byByte":{"300":1}}`, "byByte holds a number this field does not accept"},
	} {
		t.Run(tt.body, func(t *testing.T) {
			req.Equal(t, tt.want, decodeJSONRefusal(t, tt.body, &probeTextShapes{}))
		})
	}
}

// postgresReadsUUID stands in for Postgres's uuid input on a text uuid.Parse
// accepts, so it is held to the cast itself (TYRE-379). The 38-byte rows try
// each ASCII first and last byte but NUL, which Postgres text cannot carry,
// the 32 and 36 rows try each hex digit in either case at each position, and
// the urn rows try each letter case of the prefix.
func TestPostgresReadsUUIDAgreesWithTheCast(t *testing.T) {
	appURL := os.Getenv("TEST_DATABASE_URL")
	if appURL == "" {
		t.Skip("TEST_DATABASE_URL not set; this check needs Postgres")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, appURL)
	req.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	const id = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
	const digits = "0123456789abcdefABCDEF"
	var texts []string
	for _, base := range []string{id, strings.ReplaceAll(id, "-", "")} {
		for i := range len(base) {
			for _, d := range digits {
				texts = append(texts, base[:i]+string(d)+base[i+1:])
			}
		}
	}
	for first := byte(1); first < 128; first++ {
		for last := byte(1); last < 128; last++ {
			texts = append(texts, string([]byte{first})+id+string([]byte{last}))
		}
	}
	const prefix = "urn:uuid:"
	for mask := range 1 << len(prefix) {
		var p strings.Builder
		for i := range len(prefix) {
			c := prefix[i : i+1]
			if mask&(1<<i) != 0 {
				c = strings.ToUpper(c)
			}
			p.WriteString(c)
		}
		texts = append(texts, p.String()+id)
	}
	accepted := texts[:0]
	for _, s := range texts {
		if _, err := uuid.Parse(s); err == nil {
			accepted = append(accepted, s)
		}
	}

	rows, err := conn.Query(ctx, `SELECT s, pg_input_is_valid(s, 'uuid') FROM unnest($1::text[]) AS s`, accepted)
	req.NoError(t, err)
	var checked, read int
	var disagree []string
	for rows.Next() {
		var s string
		var valid bool
		req.NoError(t, rows.Scan(&s, &valid))
		checked++
		if valid {
			read++
		}
		if postgresReadsUUID(s) != valid {
			disagree = append(disagree, s)
		}
	}
	req.NoError(t, rows.Err())
	t.Logf("%d of %d texts parse as a uuid, and the cast reads %d of them", checked, len(texts), read)
	req.Equal(t, len(accepted), checked)
	req.Empty(t, disagree, "texts where postgresReadsUUID and the cast disagree")
	req.NotZero(t, read, "a control: the cast reads some of these texts")
	req.Less(t, read, checked, "a control: the cast refuses some of these texts")
}

// The unit PATCH's decoder answers a value it cannot store with the generic
// refusal and names no field, which malformed_json's registry meaning says.
func TestDecodeJSONStrictNamesNoFieldForAValueItCannotStore(t *testing.T) {
	for _, body := range []string{`{"odometer":"1500"}`, `{"odometer":1.5}`} {
		t.Run(body, func(t *testing.T) {
			rec := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(body))
			var into probeBody
			req.False(t, decodeJSONStrict(rec, r, &into))
			req.Equal(t, http.StatusBadRequest, rec.Code)
			var refusal errorBody
			req.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal))
			req.Equal(t, errorBody{Code: "malformed_json", Message: "malformed json"}, refusal)
		})
	}
}
