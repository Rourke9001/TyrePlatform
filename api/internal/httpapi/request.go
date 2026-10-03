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
		if field, named := typeErrorField(err); named {
			writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, field+" is the wrong type")
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
	// A literal null and a value after the first are both refused: Decode
	// alone accepts either and this decoder must not be laxer than
	// json.Unmarshal (TYRE-72). Confirmed by asking for a second Decode's
	// io.EOF, not dec.More(), which reports whether another *element*
	// follows within an array or object and so answers false on a body that
	// merely ends `}}` or `}]`.
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
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

// typeErrorField names the field whose value had the wrong type. The
// decoder's own text is never forwarded (ADR-0012); the field name is safe
// because encoding/json builds this path from this package's own json tags,
// never caller text, so no length bound is needed here.
func typeErrorField(err error) (string, bool) {
	var typeErr *json.UnmarshalTypeError
	if !errors.As(err, &typeErr) || typeErr.Field == "" {
		return "", false
	}
	return typeErr.Field, true
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
// way listTyres and assignDriver already parse their dates. A string that
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
	if _, err := time.Parse(isoDate, trimmed); err != nil {
		return nil, invalid(field, "must be a date as YYYY-MM-DD")
	}
	return &trimmed, nil
}

// optionalIDOrClear reads a nullable id with the three states above. A value
// that is neither absent nor empty must parse as a uuid here rather than
// reach the ::uuid cast as a 22P02 naming no field at all (ADR-0013
// decision 5).
func optionalIDOrClear(field string, raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return &trimmed, nil
	}
	if _, err := uuidField(field, trimmed); err != nil {
		return nil, err
	}
	return &trimmed, nil
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
