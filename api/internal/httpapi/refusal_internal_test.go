package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	req "github.com/stretchr/testify/require" // aliased: see ratelimit_test.go
)

// The Content-Type assertion is the point of this test, not decoration. See
// writeStatus for what the header ordering protects (ADR-0012).
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

// The same invariant for the success path: every handler that answers 201
// goes through writeStatus, so this is the one place the header order is
// pinned for all of them.
func TestWriteStatusKeepsContentTypeAcrossTheStatus(t *testing.T) {
	rec := httptest.NewRecorder()

	writeStatus(context.Background(), rec, http.StatusCreated, map[string]string{"id": "x"})

	req.Equal(t, http.StatusCreated, rec.Code)
	req.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	req.JSONEq(t, `{"id":"x"}`, rec.Body.String())
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
			name:     "an unreadable date is canned identically",
			sqlErr:   &pgconn.PgError{Code: "22007", Message: `invalid input syntax for type date: "soon"`},
			want:     refusal{status: http.StatusUnprocessableEntity, code: codeInvalidSubmission, message: msgInvalidSubmission},
			isClient: true,
		},
		{
			name:     "an out-of-range date is canned identically",
			sqlErr:   &pgconn.PgError{Code: "22008", Message: "date/time field value out of range: \"31/12/2026\""},
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
			name:     "TY009 forwards, now reachable through app.fit_tyre",
			sqlErr:   &pgconn.PgError{Code: "TY009", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY009", message: "x"},
			isClient: true,
		},
		{
			name:     "TY004 forwards, a payload naming a position not on the vehicle's configuration",
			sqlErr:   &pgconn.PgError{Code: "TY004", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY004", message: "x"},
			isClient: true,
		},
		{
			name:     "TY005 forwards, the busiest refusal: any of submit_inspection's many payload validations",
			sqlErr:   &pgconn.PgError{Code: "TY005", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY005", message: "x"},
			isClient: true,
		},
		{
			name:     "TY006 forwards, a payload asserting the derived governing_tread_mm field",
			sqlErr:   &pgconn.PgError{Code: "TY006", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY006", message: "x"},
			isClient: true,
		},
		{
			name:     "TY014 forwards, a fitment write refused",
			sqlErr:   &pgconn.PgError{Code: "TY014", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY014", message: "x"},
			isClient: true,
		},
		{
			name:     "TY015 forwards, the retread cap",
			sqlErr:   &pgconn.PgError{Code: "TY015", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY015", message: "x"},
			isClient: true,
		},
		{
			name:     "TY016 forwards, a unit status transition refused",
			sqlErr:   &pgconn.PgError{Code: "TY016", Message: "x"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY016", message: "x"},
			isClient: true,
		},
		{
			name:     "TY019 forwards: the void's refusals are written in SQL",
			sqlErr:   &pgconn.PgError{Code: "TY019", Message: "this inspection is already voided"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY019", message: "this inspection is already voided"},
			isClient: true,
		},
		{
			name:     "TY021 forwards its message, which tells the driver to check the clock",
			sqlErr:   &pgconn.PgError{Code: "TY021", Message: "submitted_at 2026-09-06T10:00:00Z is more than 5 minutes ahead of the server clock; check the device time and resubmit"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY021", message: "submitted_at 2026-09-06T10:00:00Z is more than 5 minutes ahead of the server clock; check the device time and resubmit"},
			isClient: true,
		},
		{
			name:     "TY022 forwards: the resolution's refusals name the report, not a table",
			sqlErr:   &pgconn.PgError{Code: "TY022", Message: "stale: the rig ended on 2026-09-07 06:00:00+02"},
			want:     refusal{status: http.StatusUnprocessableEntity, code: "TY022", message: "stale: the rig ended on 2026-09-07 06:00:00+02"},
			isClient: true,
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
		{"duplicate email", "23505", "app_user_tenant_email_key", "email_taken", http.StatusConflict},
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

// A conflictCodes key that names no constraint or index in the schema is a
// mapping the database can never fire, so its refusal silently degrades to
// the generic conflict (TYRE-95). White-box on purpose: the map is
// unexported, and asserting through behaviour would mean provoking every
// race each constraint guards.
func TestConflictCodesNameLiveSchemaObjects(t *testing.T) {
	ctx := context.Background()
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL not set; this check needs a migrated Postgres")
	}
	conn, err := pgx.Connect(ctx, adminURL)
	req.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	for name := range conflictCodes {
		// pg_constraint misses plain unique indexes (000027's email key is an
		// index, not a table constraint), so an index by the name also counts:
		// a 23505 from either carries the name in ConstraintName.
		var exists bool
		req.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1)
			     OR EXISTS (SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i')`,
			name).Scan(&exists))
		req.True(t, exists,
			"conflictCodes names %q, which no constraint or index in the schema carries; its refusal can never fire", name)
	}
}

// registryEntry mirrors one entry of refusal_codes.json (ADR-0012, TYRE-153,
// TYRE-212). meaning/note/raisedBy exist for a human reader and no test
// asserts on them; HTTPStatus is compared against submitStatus's own value
// below, not just checked for nil.
type registryEntry struct {
	Source     string `json:"source"`
	HTTPStatus *int   `json:"httpStatus"`
}

// loadRefusalRegistry reads the one file both the Go and TypeScript sides
// check against (web/lint/refusal.test.ts reads the same path from its own
// side of the tree). Failing to parse it is a test setup error, not a
// registry gap, so it fails the test rather than skipping.
func loadRefusalRegistry(t *testing.T) map[string]registryEntry {
	t.Helper()
	raw, err := os.ReadFile("refusal_codes.json")
	req.NoError(t, err)
	var entries map[string]json.RawMessage
	req.NoError(t, json.Unmarshal(raw, &entries))
	delete(entries, "_comment")
	registry := make(map[string]registryEntry, len(entries))
	for code, body := range entries {
		var e registryEntry
		req.NoError(t, json.Unmarshal(body, &e), "decoding registry entry %q", code)
		registry[code] = e
	}
	return registry
}

// tyCodeShape matches a code by our own class, never a standard Postgres
// SQLSTATE (ADR-0012: no standard class begins with T), so it separates a
// codeXxx constant's TY-class values (codeVehicleNotVisible = "TY007") from
// its named ones without needing to know which is which in advance.
var tyCodeShape = regexp.MustCompile(`^TY[0-9]+$`)

// codeConstantValues returns the value of every const or var in f whose name
// begins with "code" and whose value is a string literal. It reads the parsed
// declarations rather than matching lines, so a grouped, one-line, typed,
// multi-name or function-local declaration is found the same way (TYRE-303).
func codeConstantValues(t *testing.T, f *ast.File) map[string]bool {
	t.Helper()
	values := map[string]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		decl, ok := n.(*ast.GenDecl)
		if !ok || (decl.Tok != token.CONST && decl.Tok != token.VAR) {
			return true
		}
		for _, spec := range decl.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, name := range vs.Names {
				if !strings.HasPrefix(name.Name, "code") || i >= len(vs.Values) {
					continue
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				v, err := strconv.Unquote(lit.Value)
				req.NoError(t, err, "unquoting %s", name.Name)
				values[v] = true
			}
		}
		return true
	})
	return values
}

// discoverGoCodeConstants parses every non-test .go file in this package and
// returns the value of every code constant it declares. Read from source at
// test time, not hand-listed, so a constant added or renamed changes the
// result with no edit here (TYRE-184 F6).
func discoverGoCodeConstants(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(".")
	req.NoError(t, err)
	fset := token.NewFileSet()
	values := map[string]bool{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		req.NoError(t, err)
		maps.Copy(values, codeConstantValues(t, f))
	}
	return values
}

// One plant per declaration form Go allows for a code constant, and one
// non-code name the prefix filter must skip (TYRE-303).
func TestCodeConstantDiscoveryReachesEveryDeclarationForm(t *testing.T) {
	src := `package p

const (
	codeBlock = "block"
)

const codeOneLine = "one_line"

type wireCode string

const codeTyped wireCode = "typed"

var codeVar = "var"

const codePairA, codePairB = "pair_a", "pair_b"

var codeRaw = ` + "`raw`" + `

func f() {
	const codeLocal = "local"
}

const msgProbe = "not_a_code"
`
	f, err := parser.ParseFile(token.NewFileSet(), "plants.go", src, 0)
	req.NoError(t, err)
	req.Equal(t, map[string]bool{
		"block": true, "one_line": true, "typed": true, "var": true,
		"pair_a": true, "pair_b": true, "raw": true, "local": true,
	}, codeConstantValues(t, f))
}

// TestRefusalCodesRegistryCoversGoWireVocabulary is the registry's Go-side
// half (TYRE-153). Named codes are checked as set equality in both
// directions: a renamed constant leaves a stale registry key that a
// one-directional check would never flag. A TY code reaches the wire two
// ways, and each is checked. A TY-shaped Go constant (codeVehicleNotVisible)
// is written by Go directly, so it must be a registry key with a non-null
// httpStatus (TYRE-303). A code submitStatus maps must be a registry key
// whose httpStatus equals submitStatus's value, and every registry TY key
// with a non-null httpStatus must have a submitStatus entry.
//
// Rename codeConflict's value and this goes red twice: the old value is a
// registry key nothing in Go declares any more, and the new value is a Go
// constant no registry key names.
func TestRefusalCodesRegistryCoversGoWireVocabulary(t *testing.T) {
	registry := loadRefusalRegistry(t)
	goConstants := discoverGoCodeConstants(t)

	goNonTY := map[string]bool{}
	for v := range goConstants {
		if !tyCodeShape.MatchString(v) {
			goNonTY[v] = true
			continue
		}
		entry, named := registry[v]
		req.True(t, named, "Go declares code %q, which refusal_codes.json does not name", v)
		req.NotNil(t, entry.HTTPStatus,
			"Go declares code %q and writes it to the wire, but refusal_codes.json records it as unreachable (null httpStatus)", v)
	}
	registryNonTY := map[string]bool{}
	registryTYReachable := map[string]bool{}
	registryTYUnreachable := map[string]bool{}
	for code, e := range registry {
		switch {
		case !tyCodeShape.MatchString(code):
			registryNonTY[code] = true
		case e.HTTPStatus != nil:
			registryTYReachable[code] = true
		default:
			registryTYUnreachable[code] = true
		}
	}

	for code := range goNonTY {
		req.True(t, registryNonTY[code], "Go declares code %q, which refusal_codes.json does not name", code)
	}
	for code := range registryNonTY {
		req.True(t, goNonTY[code], "refusal_codes.json names %q, which no codeXxx constant in this package declares any more", code)
	}

	for code := range submitStatus {
		if !tyCodeShape.MatchString(code) {
			continue
		}
		req.False(t, registryTYUnreachable[code],
			"submitStatus maps %q, but refusal_codes.json records it as unreachable (null httpStatus)", code)
		req.True(t, registryTYReachable[code],
			"submitStatus maps %q, which refusal_codes.json does not carry a reachable (non-null httpStatus) entry for", code)
		req.Equal(t, submitStatus[code], *registry[code].HTTPStatus,
			"submitStatus and refusal_codes.json disagree on %q's HTTP status", code)
	}
	for code := range registryTYReachable {
		_, inSubmitStatus := submitStatus[code]
		req.True(t, inSubmitStatus,
			"refusal_codes.json marks %q reachable (non-null httpStatus), but submitStatus has no entry for it", code)
	}
}

// tyCodeRaise matches a TY code at a raise site only: USING ERRCODE, or RAISE
// [level] SQLSTATE. A handler's WHEN SQLSTATE 'TY001' names a code it traps,
// not one it raises, and must not count (TYRE-303). PL/pgSQL keywords are
// case-insensitive and USING accepts := as well as =, hence both.
var tyCodeRaise = regexp.MustCompile(`(?i)(?:ERRCODE\s*:?=\s*|RAISE\s+(?:[a-z]+\s+)?SQLSTATE\s+)'(TY[0-9]+)'`)

// Each raise form PL/pgSQL accepts, and the handler form that must not count.
func TestTYCodeRaiseMatchesRaiseSitesOnly(t *testing.T) {
	tests := []struct {
		src  string
		want []string
	}{
		{`RAISE EXCEPTION USING ERRCODE = 'TY001', MESSAGE = 'x';`, []string{"TY001"}},
		{"RAISE EXCEPTION USING\n    ERRCODE  = 'TY002',", []string{"TY002"}},
		{`RAISE EXCEPTION USING ERRCODE := 'TY003';`, []string{"TY003"}},
		{`raise exception using errcode = 'TY004';`, []string{"TY004"}},
		{`RAISE SQLSTATE 'TY005';`, []string{"TY005"}},
		{`RAISE EXCEPTION SQLSTATE 'TY006';`, []string{"TY006"}},
		{`WHEN SQLSTATE 'TY007' OR SQLSTATE 'TY008' OR unique_violation THEN`, nil},
	}
	for _, tt := range tests {
		t.Run(tt.src, func(t *testing.T) {
			var got []string
			for _, m := range tyCodeRaise.FindAllStringSubmatch(tt.src, -1) {
				got = append(got, m[1])
			}
			req.Equal(t, tt.want, got)
		})
	}
}

// TestEveryTYCodeRaisedInSchemaIsRegistered is the registry's database-side
// half (TYRE-212), checked as set equality: every TY code any live
// app-schema function raises, whether or not a route can reach it, must be a
// registry key, and every TY key the registry names must still be raised
// somewhere live. Unlike TestConflictCodesNameLiveSchemaObjects this reads
// pg_proc's own source rather than a Go-side literal list, because the thing
// being audited is what the database raises, not what Go already expects.
// p.prokind <> 'a' excludes aggregates, which pg_get_functiondef refuses.
func TestEveryTYCodeRaisedInSchemaIsRegistered(t *testing.T) {
	ctx := context.Background()
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL not set; this check needs a migrated Postgres")
	}
	conn, err := pgx.Connect(ctx, adminURL)
	req.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	rows, err := conn.Query(ctx,
		`SELECT pg_get_functiondef(p.oid)
		   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		  WHERE n.nspname = 'app' AND p.prokind <> 'a'`)
	req.NoError(t, err)
	defer rows.Close()

	raised := map[string]bool{}
	for rows.Next() {
		var def string
		req.NoError(t, rows.Scan(&def))
		for _, m := range tyCodeRaise.FindAllStringSubmatch(def, -1) {
			raised[m[1]] = true
		}
	}
	req.NoError(t, rows.Err())
	req.NotEmpty(t, raised, "the sweep found no TY code at all; the query itself is probably broken")

	registry := loadRefusalRegistry(t)
	registryTY := map[string]bool{}
	for code := range registry {
		if tyCodeShape.MatchString(code) {
			registryTY[code] = true
		}
	}

	for code := range raised {
		req.True(t, registryTY[code], "the live schema raises %q, which refusal_codes.json does not name", code)
	}
	for code := range registryTY {
		req.True(t, raised[code], "refusal_codes.json names %q as a TY code, but no live app-schema function raises it any more", code)
	}
}
