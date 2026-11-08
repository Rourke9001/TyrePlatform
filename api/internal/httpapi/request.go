package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// pathID parses a URL path parameter as a uuid, refusing 400 bad_request if
// it does not even parse. A path that fails to parse is a malformed request,
// not an invalid submission, and every id-carrying route answers it the same
// way (U7).
func pathID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	raw := chi.URLParam(r, name)
	id, err := uuid.Parse(raw)
	if err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "malformed id in path")
		return uuid.Nil, false
	}
	return id, true
}

// writeJSON is the one encode-and-log path shared by the list handlers. It
// encodes exactly what it is handed. The empty-vs-null guarantee belongs to
// each caller's slice initialisation, not to this function.
func writeJSON(ctx context.Context, w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.ErrorContext(ctx, "encoding response", "err", err)
	}
}

// errorBody is the refusal envelope every endpoint answers with (ADR-0012).
// Code is the machine-readable reason a client branches on.
// Message's audience depends on who wrote it (ADR-0013): a message written in
// Go or raised as a TY in SQL is ours and may be rendered, and a message
// Postgres wrote is canned before it ever reaches this struct. A driver's
// sentence is still the client's, keyed on Code. That is FR-OFF-013's
// recovery action and not a diagnostic.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeError is the only way a refusal reaches the wire, so that one shape
// covers every endpoint rather than each inventing its own (ADR-0012).
func writeError(ctx context.Context, w http.ResponseWriter, status int, code, message string) {
	writeStatus(ctx, w, status, errorBody{Code: code, Message: message})
}

// writeStatus is how a handler sends a JSON body under an explicit status;
// a bodiless 204 writes its header directly. Content-Type is set before
// WriteHeader because WriteHeader locks the header map in: writeJSON's own
// Set would be dropped and the response would go out as text/plain with
// every status and body assertion still green.
func writeStatus(ctx context.Context, w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(ctx, w, body)
}

// maxWriteBytes caps every write body: a create, a PATCH, a fitment write.
// It is a transport limit, not a policy one: the largest of these requests is
// a handful of short strings.
const maxWriteBytes = 16 << 10

// maxTextLen caps every free-text field on a write. A transport limit for the
// same reason. The columns are unbounded text, and the database is not the
// place to discover that a client sent a megabyte of description. text()
// counts it in runes (TYRE-72 D7); the other sites that check it count bytes.
const maxTextLen = 200

// maxTagsPerPatch caps how many tags one edit may name. A transport limit like
// the two above, not a rule about fleets: how a tenant labels its units is its
// own business (rule 5), and nothing in the schema bounds the set. What is
// bounded here is the work one request may ask for. A tag replacement is a
// delete and an insert per name inside the row lock patchUnit holds.
const maxTagsPerPatch = 50

// isoDate is the only date format the API accepts or emits. A locale-sensitive
// parse is a defect waiting for a tenant in another timezone (rule 6).
const isoDate = "2006-01-02"

// invalidError is a request that is malformed as a request: a missing field,
// an unparseable id, a value outside an enum. It is answered 422 with this
// message forwarded verbatim. That is safe because the message is ours:
// written here, naming the request field and never a schema object
// (ADR-0013). A message Postgres wrote is canned, and that distinction is the
// whole of ADR-0012.
type invalidError struct {
	field, why string
}

func (e invalidError) Error() string { return e.field + " " + e.why }

func invalid(field, why string) error {
	return invalidError{field: field, why: why}
}

// decodeJSON answers the refusal itself when a body cannot be read. Validation
// runs before any transaction opens (ADR-0013): a malformed request has no
// business reaching the database, and opening a transaction to reject one is
// work a caller can ask for freely.
func decodeJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWriteBytes))
	if err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "body too large or unreadable")
		return false
	}
	if err := json.Unmarshal(raw, into); err != nil {
		if message, named := typeErrorMessage(err, into); named {
			writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, message)
			return false
		}
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
	return true
}

// decodeJSONStrict refuses an unknown key (case-insensitive match against a
// json tag) before a transaction opens. The unit PATCH is the one caller,
// and refusing here is what keeps TY008 unreachable from the API (units.go's
// patchUnitRequest). The decoder's own error text is never forwarded
// (ADR-0012); the key it names is bounded, caller-supplied input.
func decodeJSONStrict(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWriteBytes))
	if err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "body too large or unreadable")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		if field, found := unknownJSONField(err); found {
			// A byte clip, not text()'s rune bound: the key is caller text,
			// and maxWriteBytes alone would let a refusal message carry
			// kilobytes of it back out.
			if len(field) > maxTextLen {
				field = strings.ToValidUTF8(field[:maxTextLen], "")
			}
			writeError(r.Context(), w, http.StatusUnprocessableEntity, codeInvalidSubmission,
				field+" is not a field of this request")
			return false
		}
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
	// A literal null is refused, as an array, string, number or boolean is,
	// because the request is an object. Decode refuses those four itself but
	// takes null as no change, so null needs this check, while {} is an
	// object naming no field and is accepted (TYRE-94).
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
	// Anything but whitespace after the first value is refused, because
	// Decode alone stops before it and this decoder must not be laxer than
	// json.Unmarshal (TYRE-72). A second Decode must answer io.EOF. dec.More()
	// would not do, since it reports whether another *element* follows within
	// an array or object and so answers false on a body that merely ends `}}`
	// or `}]`.
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
	return true
}

// unknownFieldPrefix is encoding/json's own wording. The error it comes from
// is an untyped errors.errorString, so the key has to be recovered from the
// text; should that wording ever change, the caller degrades to the generic
// malformed-json refusal rather than to a confidently wrong field name.
const unknownFieldPrefix = `json: unknown field `

func unknownJSONField(err error) (string, bool) {
	msg := err.Error()
	if !strings.HasPrefix(msg, unknownFieldPrefix) {
		return "", false
	}
	name, unquoteErr := strconv.Unquote(strings.TrimPrefix(msg, unknownFieldPrefix))
	if unquoteErr != nil {
		return "", false
	}
	return name, true
}

// typeErrorMessage words a refusal for a value the field could not take, or
// answers false when err is not a type error or typeErrorField cannot name
// the field. The name carries no caller key (TYRE-379, U181), so it stops at
// a map.
// It also leaves out a slice's index. Each message says what the field holds,
// not what it is, since the value may sit inside the named field (TYRE-379).
func typeErrorMessage(err error, into any) (string, bool) {
	var typeErr *json.UnmarshalTypeError
	if !errors.As(err, &typeErr) {
		return "", false
	}
	field, named := typeErrorField(typeErr, into)
	if !named {
		return "", false
	}
	// A number past its type's range, or with a minus sign on an unsigned
	// kind or an exponent or decimal point on an integer kind, is still a
	// number, and calling it a value of the wrong type would send the caller
	// to fix the wrong thing (TYRE-379).
	if strings.HasPrefix(typeErr.Value, "number ") && isNumber(deref(typeErr.Type)) {
		return field + " holds a number this field does not accept", true
	}
	return field + " holds a value of the wrong type", true
}

func isNumber(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		return true
	default:
		return false
	}
}

// typeErrorField names the field whose value the decoder could not store, in
// this package's json tags only, so no caller text reaches the refusal
// (TYRE-379, U181). From Go 1.27 the decoder's path carries the caller's map
// keys, slice indexes and key spelling, so the name is rebuilt by walking
// that path through into's type, and it stops at a map, whose key is caller
// text. A segment more than one field could answer, or a path the walk cannot
// resolve, names nothing, and the refusal is the generic one.
func typeErrorField(typeErr *json.UnmarshalTypeError, into any) (string, bool) {
	if typeErr.Field == "" {
		return "", false
	}
	names, leaf, ok := tagPath(reflect.TypeOf(into), strings.Split(typeErr.Field, "."))
	if !ok || len(names) == 0 {
		return "", false
	}
	// A backstop for a shape the count cannot see, such as an embedded
	// pointer to an unexported struct, which the decoder reports as the
	// outer struct's type.
	if leaf != nil && typeErr.Type != nil && leaf != deref(typeErr.Type) {
		return "", false
	}
	return strings.Join(names, "."), true
}

// tagPath answers the tag names along segments and the type the walk ends
// on. A map stops the walk with no type to check, since what follows it in
// the path is the caller's key, so typeErrorField's backstop does not reach
// past a map.
func tagPath(t reflect.Type, segments []string) ([]string, reflect.Type, bool) {
	t = deref(t)
	if t == nil {
		return nil, nil, false
	}
	if len(segments) == 0 {
		return nil, t, true
	}
	switch t.Kind() {
	case reflect.Map:
		return nil, nil, true
	case reflect.Slice, reflect.Array:
		// Go 1.27 writes every element's index into the path, so a segment
		// that is not one resolves nothing.
		if !isIndex(segments[0]) {
			return nil, nil, false
		}
		return tagPath(t.Elem(), segments[1:])
	case reflect.Struct:
		name, field, ok := jsonField(t, segments[0])
		if !ok {
			return nil, nil, false
		}
		rest, leaf, ok := tagPath(field, segments[1:])
		if !ok {
			return nil, nil, false
		}
		return append([]string{name}, rest...), leaf, true
	default:
		return nil, nil, false
	}
}

func deref(t reflect.Type) reflect.Type {
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

func isIndex(segment string) bool {
	_, err := strconv.ParseUint(segment, 10, 0)
	return err == nil
}

type jsonMatch struct {
	name string
	typ  reflect.Type
}

// jsonField answers the one field whose name folds equal to segment, counted
// through untagged embedded structs, by its tag's spelling rather than the
// caller's. Two such fields answer nothing. The decoder chooses between them
// (an exact name first, then the shallower field), and that choice is not
// reproduced here.
func jsonField(t reflect.Type, segment string) (string, reflect.Type, bool) {
	found := foldMatches(t, segment, map[reflect.Type]bool{})
	if len(found) != 1 {
		return "", nil, false
	}
	return found[0].name, found[0].typ, true
}

// foldMatches skips the fields encoding/json skips: one tagged exactly "-",
// and an unexported field that is not an embedded struct. A tagged embedded
// struct is a named field whether or not its type is exported. seen stops a
// type that embeds itself.
func foldMatches(t reflect.Type, segment string, seen map[reflect.Type]bool) []jsonMatch {
	if seen[t] {
		return nil
	}
	seen[t] = true
	var found []jsonMatch
	for i := range t.NumField() {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		name, _, _ := strings.Cut(tag, ",")
		embeddedStruct := f.Anonymous && deref(f.Type).Kind() == reflect.Struct
		if embeddedStruct && name == "" {
			found = append(found, foldMatches(deref(f.Type), segment, seen)...)
			continue
		}
		if !f.IsExported() && !embeddedStruct {
			continue
		}
		if name == "" {
			name = f.Name
		}
		if strings.EqualFold(name, segment) {
			found = append(found, jsonMatch{name, f.Type})
		}
	}
	return found
}

// refuseInvalid answers a validation failure and reports whether it did, so a
// handler reads as a straight line of guard clauses.
func refuseInvalid(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	writeError(r.Context(), w, http.StatusUnprocessableEntity, codeInvalidSubmission, err.Error())
	return true
}

// text trims and length-checks an optional free-text field, answering nil for
// an absent or blank one so the column holds NULL rather than an empty string.
// maxTextLen bounds runes, not bytes: a multibyte description (the rig
// descriptor, TYRE-72) is text a controller typed, not wire size to police.
// maxWriteBytes already does that (TYRE-72 D7).
func text(field string, in *string) (*string, error) {
	if in == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*in)
	if trimmed == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(trimmed) > maxTextLen {
		return nil, invalid(field, "is too long")
	}
	return &trimmed, nil
}

// uuidField is the body-field counterpart of pathID: an id that does not
// parse is refused before a transaction opens, naming the field, rather than
// reaching a uuid parameter as a raw string and coming back as Postgres's
// 22P02 with no field in it (ADR-0013 decision 5).
func uuidField(field, raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, invalid(field, "must be a uuid")
	}
	return id, nil
}

// errUUIDForm is castableUUID's refusal, for a text uuid.Parse reads and a
// ::uuid cast does not.
var errUUIDForm = errors.New("a uuid in a form Postgres does not read")

// castableUUID is a uuid.UUID whose text must also be a form a ::uuid cast
// reads, for a body sent on to SQL unparsed (ADR-0013 decision 5). The check
// is a decoding method, not a test of the decoded value, because the decoder
// runs it on the string under every key that names the field, keys that
// differ only in case included, and Unmarshal answers the first error. On
// success the decoded value is the last of those keys not holding null, and
// Postgres reads the last key spelt exactly as the tag, so the two can differ
// and a caller must not use the decoded value (TYRE-379).
type castableUUID uuid.UUID

func (id *castableUUID) UnmarshalText(text []byte) error {
	if err := (*uuid.UUID)(id).UnmarshalText(text); err != nil {
		return err
	}
	if !postgresReadsUUID(string(text)) {
		return errUUIDForm
	}
	return nil
}

// postgresReadsUUID answers whether a ::uuid cast reads s, a text uuid.Parse
// has accepted. Of uuid.Parse's four lengths, Postgres reads 32 and 36, and
// 38 only as {...}, where uuid.Parse ignores the first and last bytes.
// Postgres reads none of length 45, the urn:uuid: form (TYRE-379).
func postgresReadsUUID(s string) bool {
	switch len(s) {
	case 32, 36:
		return true
	case 38:
		return s[0] == '{' && s[37] == '}'
	default:
		return false
	}
}

// requiredText refuses an absent value, never a badly shaped one. A tread is
// carried as a string end to end and cast ::numeric in SQL, where the range
// rule lives; an empty string would reach that cast as a 22P02 whose canned
// message names no field at all, which is a shape problem this side owns.
func requiredText(field, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", invalid(field, "is required")
	}
	return trimmed, nil
}

// instantField parses an optional instant before any transaction opens, the
// way listTyres already parses its date. A string that
// will not parse would otherwise reach $n::timestamptz raw, and Postgres's
// 22007/22008 would then be the refusal, canned as invalid_submission,
// which names no field; the check here is what names one. The parsed value
// is what gets bound, not the text it came from: pgx encodes a time.Time as
// a timestamptz itself, so the instant the function acts on is exactly the
// one validated here.
func instantField(field string, raw *string) (*time.Time, error) {
	if raw == nil {
		return nil, nil
	}
	at, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		return nil, invalid(field, "must be an RFC 3339 instant")
	}
	return &at, nil
}

// dateField is instantField for a civil date rather than an instant, and it
// answers the validated TEXT rather than a time.Time: a dispatch and a
// retread return carry a date the tenant's own zone resolves to an instant
// (000033, 000034), so the text is bound to $n::date and the resolution
// stays in SQL. listTyres validates its on the same way. Why the check is
// on this side at all is instantField's note. A nil raw stays nil so the
// function's own default applies rather than a Go clock's idea of today.
func dateField(field string, raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if !isISODate(trimmed) {
		return nil, invalid(field, "must be a date as YYYY-MM-DD")
	}
	return &trimmed, nil
}

// isISODate answers whether s is a date as YYYY-MM-DD that a ::date cast
// reads. time.Parse reads year 0000, which the cast refuses with 22008, so
// the year is checked as well (TYRE-379, TestDateChecksAgreeWithTheCast).
func isISODate(s string) bool {
	t, err := time.Parse(isoDate, s)
	return err == nil && t.Year() >= 1
}

// optionalID reads an optional id that SQL casts ::uuid from text, bound as
// a parameter or carried in a jsonb payload. A present value must parse as a
// uuid, and is passed on as canonical text because uuid.Parse accepts forms
// the cast does not read. A value cannot then reach that cast as a 22P02
// naming no field (ADR-0013 decision 5).
func optionalID(field string, raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	id, err := uuidField(field, *raw)
	if err != nil {
		return nil, err
	}
	canonical := id.String()
	return &canonical, nil
}

// optionalIDOrClear reads one of patchUnitArgs's nullable ids, where nil
// leaves the column alone and a blank one clears it. Any other value is
// trimmed and read as optionalID reads it.
func optionalIDOrClear(field string, raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return &trimmed, nil
	}
	return optionalID(field, &trimmed)
}

// cleanTags bounds the count, trims, refuses a blank name and drops repeats
// while keeping the caller's order. De-duplication is case-sensitive because
// the constraint it stands in front of is: app.vehicle_tag's UNIQUE
// (tenant_id, name) holds "Reefer" and "REEFER" as two names, so folding case
// here would quietly merge two labels a fleet deliberately keeps apart.
func cleanTags(in []string) ([]string, error) {
	// Counted before the de-duplication, not after: what is bounded is the
	// request, and fifty repeats of one name is the same work to read as fifty
	// distinct ones.
	if len(in) > maxTagsPerPatch {
		return nil, invalid("tags", fmt.Sprintf("may name at most %d names in one edit", maxTagsPerPatch))
	}
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, raw := range in {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, invalid("tags", "may not contain a blank name")
		}
		if len(name) > maxTextLen {
			return nil, invalid("tags", "contains a name that is too long")
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out, nil
}
