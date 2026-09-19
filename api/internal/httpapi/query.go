package httpapi

import (
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// The analytics reads take their filters from the query string. These follow
// tyres.go's `on`: validated before any transaction opens (ADR-0013 decision
// 5), refused as 422 invalid_submission through refuseInvalid, and a date
// handed on as text bound to $n::date so date resolution stays in SQL.
// Absent is nil, never a default: which calendar "today" means belongs to
// the SQL that reads it (rule 6).

func dateParam(q url.Values, name string) (*string, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return nil, nil
	}
	if _, err := time.Parse(isoDate, raw); err != nil {
		return nil, invalid(name, "must be a date as YYYY-MM-DD")
	}
	return &raw, nil
}

func uuidParam(q url.Values, name string) (*uuid.UUID, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, invalid(name, "must be a uuid")
	}
	return &id, nil
}

func positiveIntParam(q url.Values, name string) (*int, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return nil, invalid(name, "must be a whole number of at least 1")
	}
	return &n, nil
}

// oneOfParam refuses a value outside the list here rather than letting the
// view judge it: the level and class columns of the aggregate views are
// text, so a misspelt level would return no rows and read as "nothing to
// show" rather than as the mistake it is.
func oneOfParam(q url.Values, name string, allowed ...string) (*string, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return nil, nil
	}
	for _, a := range allowed {
		if raw == a {
			return &raw, nil
		}
	}
	return nil, invalid(name, "must be one of "+strings.Join(allowed, ", "))
}

// boolParam is the literal string "true", the house flag shape (units.go's
// ?open=true).
func boolParam(q url.Values, name string) bool {
	return q.Get(name) == "true"
}
