package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	// Aliased: this file shares package httpapi with httpapi.go's own
	// capability-check function named require, so the unaliased import would
	// shadow it (see ratelimit_test.go for the same convention).
	req "github.com/stretchr/testify/require"
)

// The Content-Type assertion is the point of this test, not decoration.
// writeJSON sets the header itself, but WriteHeader locks the header map in,
// so a writeError that writes the status first answers text/plain while every
// status and body assertion still passes (ADR-0012).
func TestWriteErrorEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()

	writeError(context.Background(), rec, http.StatusConflict, "TY003", "a unit in this submit was already inspected within 6 hours")

	req.Equal(t, http.StatusConflict, rec.Code)
	req.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	req.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	req.Equal(t, "TY003", body.Code)
	req.Equal(t, "a unit in this submit was already inspected within 6 hours", body.Message)
}

// The refusal vocabulary, asserted as a set (ADR-0012). The canned rows are
// the point: a Postgres-authored message names a constraint and a table, and
// neither may reach a client.
func TestRefusalForPgError(t *testing.T) {
	const fkMessage = `insert or update on table "reading" violates foreign key constraint "reading_tyre_id_fkey"`

	tests := []struct {
		name     string
		sqlErr   *pgconn.PgError
		want     refusal
		isClient bool
	}{
		{
			name:   "TY003 forwards its own message, which carries the tenant's window",
			sqlErr: &pgconn.PgError{Code: "TY003", Message: "a unit in this submit was already inspected within 6 hours"},
			want: refusal{
				status:  http.StatusConflict,
				code:    "TY003",
				message: "a unit in this submit was already inspected within 6 hours",
			},
			isClient: true,
		},
		{
			name:     "TY007 forwards, and is the code the Go scope check answers with too",
			sqlErr:   &pgconn.PgError{Code: "TY007", Message: "vehicle not visible"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY007", message: "vehicle not visible"},
			isClient: true,
		},
		{
			name:   "a foreign key violation loses its constraint and table names",
			sqlErr: &pgconn.PgError{Code: "23503", Message: fkMessage},
			want: refusal{
				status:  http.StatusUnprocessableEntity,
				code:    codeInvalidSubmission,
				message: msgInvalidSubmission,
			},
			isClient: true,
		},
		{
			name:     "a check violation is canned identically",
			sqlErr:   &pgconn.PgError{Code: "23514", Message: `new row violates check constraint "reading_pressure_kpa_check"`},
			want:     refusal{status: http.StatusUnprocessableEntity, code: codeInvalidSubmission, message: msgInvalidSubmission},
			isClient: true,
		},
		{
			name:     "a not-null violation is canned identically",
			sqlErr:   &pgconn.PgError{Code: "23502", Message: `null value in column "tyre_id" violates not-null constraint`},
			want:     refusal{status: http.StatusUnprocessableEntity, code: codeInvalidSubmission, message: msgInvalidSubmission},
			isClient: true,
		},
		{
			name:     "an unparseable value is canned identically",
			sqlErr:   &pgconn.PgError{Code: "22P02", Message: `invalid input syntax for type uuid: "nope"`},
			want:     refusal{status: http.StatusUnprocessableEntity, code: codeInvalidSubmission, message: msgInvalidSubmission},
			isClient: true,
		},
		{
			name:     "a scalar where an array was promised is canned identically",
			sqlErr:   &pgconn.PgError{Code: "22023", Message: "cannot extract elements from a scalar"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: codeInvalidSubmission, message: msgInvalidSubmission},
			isClient: true,
		},
		{
			name:     "a unique violation is a conflict the client can tell from TY003",
			sqlErr:   &pgconn.PgError{Code: "23505", Message: `duplicate key value violates unique constraint "reading_pkey"`},
			want:     refusal{status: http.StatusConflict, code: codeConflict, message: msgConflict},
			isClient: true,
		},
		{
			name:     "TY010 is an invariant breach, not a client mistake",
			sqlErr:   &pgconn.PgError{Code: "TY010", Message: "submit_inspection called with no tenant or actor bound"},
			isClient: false,
		},
		{
			name:     "an unmapped SQLSTATE is not a client mistake",
			sqlErr:   &pgconn.PgError{Code: "40001", Message: "could not serialize access"},
			isClient: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, isClient := refusalForPgError(fmt.Errorf("wrapped: %w", tt.sqlErr))
			req.Equal(t, tt.isClient, isClient)
			if !tt.isClient {
				return
			}
			req.Equal(t, tt.want, got)
			req.NotContains(t, got.message, "reading_tyre_id_fkey")
			req.NotContains(t, got.message, "constraint")
			// No SQLSTATE outside our own class may become a wire code.
			if !strings.HasPrefix(tt.sqlErr.Code, "TY") {
				req.NotEqual(t, tt.sqlErr.Code, got.code)
			}
		})
	}
}

func TestRefusalForPgErrorIgnoresNonPgErrors(t *testing.T) {
	_, isClient := refusalForPgError(errors.New("a plain error"))
	req.False(t, isClient)

	_, isClient = refusalForPgError(nil)
	req.False(t, isClient)
}

// A conflict a form must act on differently from any other conflict carries
// its own code. The constraint name is translated here and never forwarded,
// so ADR-0012's guarantee that no schema object reaches the wire is unchanged
// (ADR-0013).
func TestConflictConstraintsTranslateToTheirOwnCode(t *testing.T) {
	tests := []struct {
		name       string
		sqlstate   string
		constraint string
		wantCode   string
		wantStatus int
	}{
		{"duplicate fleet number", "23505", "vehicle_tenant_id_fleet_number_key", "fleet_number_taken", http.StatusConflict},
		{"duplicate email", "23505", "app_user_tenant_id_email_key", "email_taken", http.StatusConflict},
		{"overlapping assignment", "23P01", "vehicle_driver_no_overlap", "assignment_overlaps", http.StatusConflict},
		{"an unmapped unique constraint", "23505", "some_other_key", "conflict", http.StatusConflict},
		{"an unmapped exclusion constraint", "23P01", "some_other_excl", "conflict", http.StatusConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, isClient := refusalForPgError(&pgconn.PgError{
				Code:           tt.sqlstate,
				ConstraintName: tt.constraint,
				Message:        "duplicate key value violates unique constraint \"" + tt.constraint + "\"",
			})
			req.True(t, isClient)
			req.Equal(t, tt.wantStatus, ref.status)
			req.Equal(t, tt.wantCode, ref.code)
			req.NotContains(t, ref.message, tt.constraint,
				"a constraint name reached the wire")
		})
	}
}
