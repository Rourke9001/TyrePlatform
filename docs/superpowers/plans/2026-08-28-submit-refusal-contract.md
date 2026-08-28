# Submit Refusal Contract (B3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every API refusal one JSON shape carrying a machine-readable `code`, so no Postgres constraint or table name reaches the wire and the capture client can tell FR-INS-038's duplicate window apart from any other 409.

**Architecture:** Three layers, in order. A new unexported `writeError` helper in `api/internal/httpapi/httpapi.go` becomes the only way a refusal reaches the wire, and all fourteen `http.Error` call sites plus two new chi fallback handlers route through it. `statusForPgError` becomes `refusalForPgError` and decides, per SQLSTATE, whether the database's own message is forwarded (the private `TY` class) or replaced with a canned constant (everything else). Then the client learns to read the envelope: `ApiError` gains a `code`, the outbox stores it beside `lastStatus`, and `CaptureDone` branches on it. No migration, no schema change, no SQL change of any kind — the database already raises every code this plan carries.

**Tech Stack:** Go 1.24 (run in `golang:1.24-alpine` under docker for host parity), `chi`, `pgx`/`pgconn`, `testify/require`, table-driven tests. React 19 + TypeScript strict, Vitest, Testing Library, Dexie 4, Playwright for the e2e gate.

**Spec:** `docs/superpowers/specs/2026-08-28-submit-refusal-contract-design.md`. Read it first; this plan argues from it and does not restate its reasoning. Sequencing rationale: `docs/implementation-order.md`, batch B3.

**Tickets:** TYRE-77 (Tasks 2–4) then TYRE-78 (Tasks 5–6), in that order and not the other. Task 1 is the ADR both rest on; Task 7 is the documentation close-out.

**Branch:** `TYRE-77-refusal-contract`, cut from `develop` @ `33ccd27`. The spec's commit sketch names four commits; TDD splits TYRE-77's into three and TYRE-78's into two, giving seven. The shape and order the spec claims are unchanged — ADR, then the message, then the code, then the docs.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a bug even if tests pass.

- **No Postgres constraint name, table name, or column name may reach a response body.** This is TYRE-77's whole point. `reading_tyre_id_fkey` is the canonical example and Task 3's test asserts against it by name.
- **Raw SQLSTATE never reaches the wire either.** `23503` is not a wire code. The only SQLSTATEs that appear in a response are those in the private `TY` class, which are ours.
- **No SQL changes.** No migration, no edit to `db/tests/`, no change to `app.submit_inspection`. Every code this plan carries is already raised. If you find yourself opening `db/migrations/`, you have gone outside the plan.
- **`classify()` in `web/src/capture/outbox.ts` is correct and is not touched.** TYRE-78 is explicit: do not fix the ambiguity by narrowing `23505` to a retryable status. Both refusals are permanent.
- **Every threshold, band and rate is tenant configuration** (project rule 5). This plan adds no numeric literal to a message. In particular, never write "4 hours" or "four hours" into a Go or TypeScript string — TY003's window is tenant configuration and the database interpolates it.
- **`strict: true`, and `@typescript-eslint/no-explicit-any` is an error.** Parse unknown JSON as `unknown` and narrow it. Never `any`, never a non-null assertion to get past a type.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code. `scripts/check-comment-style.mjs` runs in the hook, in `make lint` and in CI, and it is blocking. It rejects `previously`, `used to`, `no longer`, `the old/new version`, `instead of the old`, `renamed from`, `moved here from`. Write every comment in the present tense as a statement of the constraint the current code satisfies. `docs/` and `*.md` are exempt; Go, TypeScript and SQL are not.
- **Cite the requirement ID** for any non-obvious rule (`FR-INS-038`, `NFR-USE-005`, `FR-OFF-013`, `ADR-0012`).
- **Run `make check` before every commit.** Docker must be running; `make db-up` first, because `make check` runs `db-reset`, `db-test` and the Go integration tests, all of which need Postgres on 5433.
- **`make e2e` is not part of `make check`.** Task 6 changes a path the browser-smoke job asserts. Run it, or say plainly in the PR that it was not run.

## Requirement values, copied verbatim

Do not paraphrase these into the code; they are the acceptance criteria.

| Source | Text |
| --- | --- |
| NFR-USE-005 (SRS v1.4 Part 4) | "The system shall present all error messages in plain language, stating what happened and what the user should do." |
| FR-OFF-013 (SRS v1.4 Part 2) | "The system shall preserve an inspection locally where submit fails permanently, and shall present the failure to the user with a supported recovery action." |
| FR-INS-038 (SRS v1.4 Part 2) | "The system shall reject submission of a second inspection of the same unit within a configurable minimum interval, defaulting to four hours, unless overridden by a `CONTROLLER`." |
| TYRE-77 | "A mapped `23503` now answers 422 carrying a constraint name and a table name, for example `reading_tyre_id_fkey`." |
| TYRE-77 | Definition of done: "a decision on what the endpoint returns for a refusal a driver cannot act on, applied consistently across `statusForPgError`; the five `TY0xx` human-facing messages preserved and still asserted in `db/tests/004_tests.sql`; no Postgres constraint or table name reachable on the wire; `make check` green." |
| TYRE-78 | "The shape of the fix is a machine-readable code on the refusal — the `TY0xx` the database already raises — carried through `ApiError` so the client branches on the reason rather than on the status." |
| TYRE-78 | "Do not fix this by narrowing 23505 to a retryable status. Both are permanent, and the outbox is correct as it stands." |
| TYRE-78 | Definition of done: "a submit refusal carries a machine-readable reason as well as a status; `CaptureDone` names FR-INS-038's window only when that is what happened, and says something a driver can act on otherwise (NFR-USE-005, FR-OFF-013); a vitest case per branch; the outbox still treats both as permanent; `make check` green." |

**On TYRE-77's "still asserted in `db/tests/004_tests.sql`":** that file contains no message-text assertion — `grep -ci "message"` returns 0. What it asserts by name are the SQLSTATEs. The messages stay unchanged in the database and keep reaching the wire for the `TY` class, so the DoD is met as written; the spec records the correction and Task 7 fixes the same claim where it is repeated in `docs/implementation-order.md`.

## Decisions this plan makes, and why

Settled here so the implementer does not re-litigate them.

**1. Forwarding is decided by the `TY` prefix, not by an allow-list.** A map of "which SQLSTATEs are safe to forward" would forward any SQLSTATE somebody adds to `submitStatus` without updating the second map — which is TYRE-77's bug, rebuilt. Testing the prefix makes canning the default and forwarding the exception. No standard Postgres SQLSTATE class begins with `T`, so the class is genuinely ours.

**2. `errVehicleNotVisible` carries the literal code `TY007`.** The spec's §"The code table" gives the reasoning: `httpapi.go:244-253` already records that this sentinel's status and wording are TY007's deliberately, because a ScopeTenant actor meets the identical condition in SQL, and ADR-0011 denies letting two roles learn different things about the same vehicle. A separate code re-opens that gap inside the new envelope.

**3. `submitStatus` keeps its name and its comment block.** It is still the SQLSTATE-to-status map and its existing comment is the canonical explanation of why `TY001`/`TY002`/`TY010` are absent. Only `statusForPgError` is renamed, because its return type changes. Do not restructure the map, do not add `TY008` or `TY009` (see decision 4).

**4. `TY008` and `TY009` stay out of the map.** Deferred to B4, per the spec's own section. Neither is reachable through any endpoint today, so an entry could carry no test that can fail, and `000024:55` and `000025:58` state the absence in migrations that are edit-frozen.

**5. No Dexie version bump.** `draft.ts:82` indexes only `clientUuid` and `state`; `lastCode` is a plain field on the stored object, so the schema is unchanged. An entry queued before this lands has `lastCode === undefined` rather than `null`, so every read coalesces with `?? null`.

**6. The driver's sentences live in `CaptureDone`, never on the wire.** The wire message is diagnostic-grade throughout. This is the split `outbox.ts:16` already asserts ("Diagnostics only, never rendered") and the spec's §"What the message says" states it.

**7. The Go tests split across two packages, and this is not optional.** `api/internal/httpapi/httpapi_test.go` declares `package httpapi_test` — an external test package that cannot see `writeError`, `refusal`, `refusalForPgError` or any of the unexported code constants. So the white-box unit tests go in a new `refusal_internal_test.go` declaring `package httpapi`, which Go permits alongside the external one in the same directory, and the router-level tests stay external. The external tests assert **string literals** (`"not_found"`, `"unauthorized"`) rather than the constants: a black-box test that compares a constant to itself proves nothing about what reaches the wire, and the literal is the contract.

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `docs/adr/0012-api-error-envelope.md` | create | The envelope's shape and vocabulary, stated once |
| `api/internal/httpapi/httpapi.go` | modify | `writeError`, the code constants, `refusalForPgError`, the chi fallbacks, seven converted sites |
| `api/internal/httpapi/capture.go` | modify | Four converted sites |
| `api/internal/httpapi/ratelimit.go` | modify | Two converted sites |
| `api/internal/httpapi/refusal_internal_test.go` | create | `writeError` and `refusalForPgError` — white-box, `package httpapi` |
| `api/internal/httpapi/httpapi_test.go` | modify | The fallback routes and the 401, through the router — black-box, `package httpapi_test` |
| `web/src/api/client.ts` | modify | Parses the envelope; `ApiError.code` |
| `web/src/api/client.test.ts` | create | Envelope parsing, including bodies that carry none |
| `web/src/capture/outbox.ts` | modify | Stores `lastCode` beside `lastStatus` |
| `web/src/capture/CaptureFlow.tsx` | modify | Threads `lastCode` to the done screen |
| `web/src/capture/CaptureDone.tsx` | modify | Branches on the code, not the status |
| `web/src/capture/outbox.test.ts`, `CaptureFlow.test.tsx` | modify | Codes in stubs; a case per branch |
| `docs/implementation-order.md`, `api/CLAUDE.md` | modify | Corrections and close-out |

---

## Task 1: ADR-0012, the API error envelope

**Files:**
- Create: `docs/adr/0012-api-error-envelope.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the vocabulary every later task cites — the field names `code` and `message`, and the code strings listed in Step 1.

No test: this is a document. `docs/` is exempt from the comment-style checker.

- [ ] **Step 1: Write the ADR**

Follow `docs/adr/0000-template.md` exactly — the headings are `Context`, `Options considered`, `Decision`, `Consequences`, and `Consequences` has `Good:`, `Bad:`, `Revisit when:`. Status `Accepted`, date `2026-08-28`, deciders `Rourke Amiss`.

The content, in your own prose:

- **Context.** Fourteen refusal sites, all `http.Error`, all `text/plain`. `statusForPgError` forwards `pgErr.Message`, so a mapped `23503` answers 422 naming `reading_tyre_id_fkey`. ADR-0009's outbox makes an unmapped error dangerous — a 500 tells a phone to retry forever a submit that can never succeed — which is why the integrity classes were mapped in the first place, and why the fix cannot be to unmap them. TYRE-78's separate problem: `TY003` and `23505` both answer 409 and the client sees only the status.
- **Options considered.** (A) Status only, canned messages — cheapest, still leaves `TY003` and `23505` indistinguishable, so TYRE-78 is unfixed. (B) Forward raw SQLSTATE as the code — free diagnosability, but makes Postgres error classes part of the public contract, so replacing a `CHECK` with a `TY0xx` trigger later becomes a silent breaking change. (C) A `{code, message}` envelope with an API-owned vocabulary — the chosen one; its real downside is that the vocabulary now exists in Go and TypeScript as two sets of string constants with nothing but tests keeping them aligned.
- **Decision.** "We will answer every refusal with a JSON `{code, message}` envelope."
- **Consequences.** Good: one parser client-side; every later write endpoint inherits a contract instead of inventing one; support can key on a stable code. Bad: two string vocabularies in two languages; chi's fallbacks needed explicit handlers; the client must tolerate a body with no envelope, because a proxy or gateway refusal carries none. Revisit when: a second client (the dashboard) needs to branch on a code the capture app does not, or when the vocabulary passes roughly a dozen codes and a generated shared definition starts to pay for itself.

State these two rules explicitly, because later tickets depend on them:

1. `code` names the **reason**, never the layer that found it. The Go scope check and SQL's `TY007` guard answer the same condition, so they answer with the same code.
2. `TY008` and `TY009` are **deliberately absent** from `submitStatus` and B4 owns adding them, with the test that becomes possible once a vehicle write surface can raise them. Cite `000024:55` and `000025:58`, which state the absence in frozen migrations.

Include the code table from the spec's §"The code table" — both halves, source and per-site.

- [ ] **Step 2: Check the ADR number is still free**

Run: `ls docs/adr/`
Expected: `0011-actor-context-and-authorisation.md` is the highest numbered file, and no `0012-*` exists.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0012-api-error-envelope.md
git commit -m "$(cat <<'EOF'
docs: TYRE-77 ADR-0012, the API error envelope

Every refusal answers {code, message} as JSON. code names the reason,
never the layer that found it, which is why the Go scope check and SQL's
TY007 guard answer identically. TY008/TY009 stay out of the map for B4.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `writeError`, the one way a refusal reaches the wire

**Files:**
- Modify: `api/internal/httpapi/httpapi.go` (add near `writeJSON` at `:497`)
- Create: `api/internal/httpapi/refusal_internal_test.go`

**Interfaces:**
- Consumes: `writeJSON(ctx context.Context, w http.ResponseWriter, body any)`, already at `httpapi.go:497`.
- Produces: `func writeError(ctx context.Context, w http.ResponseWriter, status int, code, message string)` and `type errorBody struct { Code string \`json:"code"\`; Message string \`json:"message"\` }`. Tasks 3 and 4 call `writeError` and nothing else.

- [ ] **Step 1: Write the failing test**

Create `api/internal/httpapi/refusal_internal_test.go`. It declares `package httpapi`, not `package httpapi_test`: the existing test file is external and cannot see an unexported helper (decision 7).

```go
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
	"github.com/stretchr/testify/require"
)
```

Then the test itself:

```go
// The Content-Type assertion is the point of this test, not decoration.
// writeJSON sets the header itself, but WriteHeader locks the header map in,
// so a writeError that writes the status first answers text/plain while every
// status and body assertion still passes (ADR-0012).
func TestWriteErrorEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()

	writeError(context.Background(), rec, http.StatusConflict, "TY003", "a unit in this submit was already inspected within 6 hours")

	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	require.Equal(t, "TY003", body.Code)
	require.Equal(t, "a unit in this submit was already inspected within 6 hours", body.Message)
}
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/api:/app" -w /app \
  -v tyre-gomodcache:/go/pkg/mod golang:1.24-alpine \
  go test ./internal/httpapi/ -run TestWriteErrorEnvelope
```

Expected: FAIL — `undefined: writeError`.

- [ ] **Step 3: Write the minimal implementation**

Add immediately after `writeJSON` in `api/internal/httpapi/httpapi.go`:

```go
// errorBody is the refusal envelope every endpoint answers with (ADR-0012).
// Code is the machine-readable reason a client branches on; Message is
// diagnostic-grade and is never the source of a driver's sentence — the
// wording a driver reads is the client's, keyed on Code.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeError is the only way a refusal reaches the wire, so that one shape
// covers every endpoint rather than each inventing its own (ADR-0012).
//
// Content-Type is set before WriteHeader: WriteHeader locks the header map in,
// so writeJSON's own Set would be dropped and the response would go out as
// text/plain with every status assertion still green.
func writeError(ctx context.Context, w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(ctx, w, errorBody{Code: code, Message: message})
}
```

- [ ] **Step 4: Run the test to verify it passes**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Do not commit yet**

Tasks 2, 3 and 4 are one commit — TYRE-77's — taken at the end of Task 4, because a tree where `writeError` exists and eleven sites still call `http.Error` is not a state worth recording. If you want a checkpoint, `git add -A` without committing.

---

## Task 3: `refusalForPgError` — forward ours, can everything else

**Files:**
- Modify: `api/internal/httpapi/httpapi.go:164-203` (the `submitStatus` map and `statusForPgError`)
- Test: `api/internal/httpapi/refusal_internal_test.go` (created in Task 2)

**Interfaces:**
- Consumes: `submitStatus` (unchanged), `writeError` from Task 2.
- Produces: `type refusal struct { status int; code, message string }` and `func refusalForPgError(err error) (refusal, bool)`. Task 4 calls it from `withActor`.

Read the existing comment block at `httpapi.go:140-163` before changing anything. It is the canonical explanation of why `TY001`, `TY002` and `TY010` are absent from the map, and it stays.

- [ ] **Step 1: Write the failing test**

Add to `api/internal/httpapi/refusal_internal_test.go`, the file Task 2 created — it is `package httpapi` and can see the unexported vocabulary:

```go
// The refusal vocabulary, asserted as a set (ADR-0012). The canned rows are
// the point: a Postgres-authored message names a constraint and a table, and
// neither may reach a client.
func TestRefusalForPgError(t *testing.T) {
	const fkMessage = `insert or update on table "reading" violates foreign key constraint "reading_tyre_id_fkey"`

	tests := []struct {
		name    string
		sqlErr  *pgconn.PgError
		want    refusal
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
			name:   "TY007 forwards, and is the code the Go scope check answers with too",
			sqlErr: &pgconn.PgError{Code: "TY007", Message: "vehicle not visible"},
			want:   refusal{status: http.StatusUnprocessableEntity, code: "TY007", message: "vehicle not visible"},
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
			name:   "a unique violation is a conflict the client can tell from TY003",
			sqlErr: &pgconn.PgError{Code: "23505", Message: `duplicate key value violates unique constraint "reading_pkey"`},
			want:   refusal{status: http.StatusConflict, code: codeConflict, message: msgConflict},
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
			require.Equal(t, tt.isClient, isClient)
			if !tt.isClient {
				return
			}
			require.Equal(t, tt.want, got)
			require.NotContains(t, got.message, "reading_tyre_id_fkey")
			require.NotContains(t, got.message, "constraint")
			// No SQLSTATE outside our own class may become a wire code.
			if !strings.HasPrefix(tt.sqlErr.Code, "TY") {
				require.NotEqual(t, tt.sqlErr.Code, got.code)
			}
		})
	}
}

func TestRefusalForPgErrorIgnoresNonPgErrors(t *testing.T) {
	_, isClient := refusalForPgError(errors.New("a plain error"))
	require.False(t, isClient)

	_, isClient = refusalForPgError(nil)
	require.False(t, isClient)
}
```

The final `require.NotContains(t, got.code, "2")` asserts no raw SQLSTATE survives as a code: every SQLSTATE this map holds outside the `TY` class contains a `2`, and no code in the vocabulary does.

- [ ] **Step 2: Run it to make sure it fails**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/api:/app" -w /app \
  -v tyre-gomodcache:/go/pkg/mod golang:1.24-alpine \
  go test ./internal/httpapi/ -run TestRefusalForPgError
```

Expected: FAIL — `undefined: refusalForPgError`, `undefined: refusal`, `undefined: codeInvalidSubmission`.

- [ ] **Step 3: Add the vocabulary constants**

Add above `submitStatus` in `api/internal/httpapi/httpapi.go`:

```go
// The refusal vocabulary (ADR-0012). A code names the reason, never the layer
// that found it, which is why codeVehicleNotVisible is TY007's own: the Go
// scope check in submitInspection and app.submit_inspection's TY007 guard
// answer the same condition, and ADR-0011 denies letting two roles learn
// different things about the same vehicle.
const (
	codeUnauthorized      = "unauthorized"
	codeForbidden         = "forbidden"
	codeVehicleNotVisible = "TY007"
	codeBadRequest        = "bad_request"
	codeMalformedJSON     = "malformed_json"
	codeInvalidSubmission = "invalid_submission"
	codeConflict          = "conflict"
	codeNotFound          = "not_found"
	codeMethodNotAllowed  = "method_not_allowed"
	codeRateLimited       = "rate_limited"
	codeInternal          = "internal"
)

// Canned replacements for messages Postgres wrote. A driver's recovery action
// is the same for all of them — the payload is wrong in a way the database
// declined to name, and it fails identically on every retry — so one code
// covers the class (ADR-0012). msgConflict is separate only because it is a
// 409 and must be distinguishable from TY003's duplicate window (FR-INS-038).
const (
	msgInvalidSubmission = "the submission was refused as invalid"
	msgConflict          = "the submission conflicts with data already recorded"
	msgUnauthorized      = "the request does not identify a user"
	msgForbidden         = "this action is not permitted for this role"
	msgVehicleNotVisible = "vehicle not visible"
	msgInternal          = "internal error"
)
```

- [ ] **Step 4: Replace `statusForPgError` with `refusalForPgError`**

Replace `api/internal/httpapi/httpapi.go:191-201` (the whole `statusForPgError` function; leave `submitStatus` and its comment block above it untouched):

```go
// refusal is what the wire carries for a client mistake (ADR-0012).
type refusal struct {
	status  int
	code    string
	message string
}

// Forwarding is decided by the TY class rather than by a list of safe codes.
// A message in that class is ours: app.submit_inspection writes it, it names
// no table or constraint, and it interpolates values a Go constant could not
// state — TY003's window is tenant configuration (rule 5, FR-INS-038). Every
// other message is Postgres's and can name a constraint and a table
// (reading_tyre_id_fkey), so it is canned. A SQLSTATE added to submitStatus
// without a case below is canned by default, which is the safe direction.
//
// No standard Postgres SQLSTATE class begins with T, so the class is ours
// alone and the prefix cannot collide.
func refusalForPgError(err error) (refusal, bool) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return refusal{}, false
	}
	status, found := submitStatus[pgErr.Code]
	if !found {
		return refusal{}, false
	}
	switch {
	case strings.HasPrefix(pgErr.Code, "TY"):
		return refusal{status: status, code: pgErr.Code, message: pgErr.Message}, true
	case pgErr.Code == "23505":
		return refusal{status: status, code: codeConflict, message: msgConflict}, true
	default:
		return refusal{status: status, code: codeInvalidSubmission, message: msgInvalidSubmission}, true
	}
}
```

Add `"strings"` to the import block if it is absent.

- [ ] **Step 5: Point `withActor` at the new signature**

In `api/internal/httpapi/httpapi.go`, `withActor` currently reads `code, msg, isClient := statusForPgError(err)` and later `http.Error(w, msg, code)`. Change the call to:

```go
	ref, isClient := refusalForPgError(err)
```

and the `case isClient:` branch to:

```go
	case isClient:
		writeError(ctx, w, ref.status, ref.code, ref.message)
		return false
```

Leave the other branches alone for now; Task 4 converts them.

- [ ] **Step 6: Run the test to verify it passes**

Same command as Step 2. Expected: PASS, all ten subtests.

- [ ] **Step 7: Do not commit yet**

The build is green but eleven `http.Error` sites remain. Task 4 finishes the commit.

---

## Task 4: Convert every remaining site, and give chi its fallbacks

**Files:**
- Modify: `api/internal/httpapi/httpapi.go` (`requireActor`, `withActor`, `New`)
- Modify: `api/internal/httpapi/capture.go:112`, `:328`, `:332`, `:344`
- Modify: `api/internal/httpapi/ratelimit.go:108`, `:124`
- Test: `api/internal/httpapi/httpapi_test.go`

**Interfaces:**
- Consumes: `writeError` (Task 2), the code and message constants (Task 3).
- Produces: an API where `grep -rn "http.Error(" api/internal/httpapi/*.go` returns nothing outside tests.

- [ ] **Step 1: Write the failing test**

Add to `api/internal/httpapi/httpapi_test.go` — the existing external file, matching its `httpapi.New(nil, nil)` pattern at `:442`. The expected codes are written as literals, not constants: this is a black-box test and the literal is the wire contract (decision 7).

```go
// The refusal envelope as a client meets it (ADR-0012). chi answers an
// unrouted path and a wrong method itself, in text/plain, unless the router
// registers handlers — a contract every later endpoint inherits does not ship
// with two exceptions to it.
func TestRefusalsCarryTheEnvelope(t *testing.T) {
	h := httpapi.New(nil, nil)

	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
		wantCode   string
	}{
		// Outside /api deliberately: requireActor is mounted on that group and
		// answers 401 before an unrouted path ever reaches chi's NotFound.
		{"an unrouted path", http.MethodGet, "/nothing-here", http.StatusNotFound, "not_found"},
		{"a wrong method on a real route", http.MethodDelete, "/healthz", http.StatusMethodNotAllowed, "method_not_allowed"},
		// A nil resolver names nobody, which is the production default.
		{"a request naming no user", http.MethodGet, "/api/me", http.StatusUnauthorized, "unauthorized"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, nil))

			require.Equal(t, tt.wantStatus, rec.Code, rec.Body.String())
			require.Equal(t, "application/json", rec.Header().Get("Content-Type"))

			var body struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
			require.Equal(t, tt.wantCode, body.Code)
			require.NotEmpty(t, body.Message)
		})
	}
}
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/api:/app" -w /app \
  -v tyre-gomodcache:/go/pkg/mod golang:1.24-alpine \
  go test ./internal/httpapi/ -run TestRefusalsCarryTheEnvelope
```

Expected: FAIL on all three subtests, each with `Content-Type` reading `text/plain; charset=utf-8`.

- [ ] **Step 3: Register the chi fallbacks**

In `New` in `api/internal/httpapi/httpapi.go`, immediately after `r := chi.NewRouter()`:

```go
	// chi answers both of these itself, in text/plain, unless they are
	// registered — the envelope's only escapees (ADR-0012).
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(r.Context(), w, http.StatusNotFound, codeNotFound, "no such endpoint")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(r.Context(), w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "that method is not allowed on this endpoint")
	})
```

- [ ] **Step 4: Convert the eleven remaining sites**

In `api/internal/httpapi/httpapi.go` — both `requireActor` sites and `withActor`'s identity check:

```go
	writeError(r.Context(), w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
```

Inside `withActor` the context variable is already `ctx`, so its three remaining branches read:

```go
	// ErrNoSuchActor branch:
		writeError(ctx, w, http.StatusForbidden, codeForbidden, msgForbidden)
	// errForbidden branch:
		writeError(ctx, w, http.StatusForbidden, codeForbidden, msgForbidden)
	// errVehicleNotVisible branch:
		writeError(ctx, w, http.StatusUnprocessableEntity, codeVehicleNotVisible, msgVehicleNotVisible)
	// default branch, after the slog.ErrorContext call:
		writeError(ctx, w, http.StatusInternalServerError, codeInternal, msgInternal)
```

In `api/internal/httpapi/capture.go`:

```go
	// :112, an unparseable vehicle id in the path
	writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "bad vehicle id")
	// :328, io.ReadAll failing — the size cap or a transfer that died
	writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "body too large or unreadable")
	// :332 and :344, a complete body that is not JSON
	writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
```

In `api/internal/httpapi/ratelimit.go`:

```go
	// :108, no bound identity — TY010's case, an invariant breach
	writeError(r.Context(), w, http.StatusInternalServerError, codeInternal, msgInternal)
	// :124, after the Retry-After header is set
	writeError(r.Context(), w, http.StatusTooManyRequests, codeRateLimited, "too many requests")
```

At `:124` the `Retry-After` header is set before `writeError`, which is required — `writeError` calls `WriteHeader` and locks the map.

- [ ] **Step 5: Verify no `http.Error` survives outside tests**

```bash
grep -rn "http.Error(" api/internal/httpapi/*.go | grep -v _test
```

Expected: no output.

- [ ] **Step 6: Run the whole package**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/api:/app" -w /app \
  -v tyre-gomodcache:/go/pkg/mod golang:1.24-alpine \
  go build ./... && go vet ./...
```

Expected: clean. Then run `make db-up` and `make check`.

Expected: green. If an integration test in `capture_test.go` fails, read the failure before changing it — those tests assert statuses, and a status changing means something in Steps 3–4 is wrong, not that the test is.

- [ ] **Step 7: Commit**

```bash
git add api/internal/httpapi/
git commit -m "$(cat <<'EOF'
feat(api): TYRE-77 answer every refusal with the ADR-0012 envelope

A message Postgres wrote can name a constraint and a table, so only the
TY class forwards: those are ours, name neither, and interpolate the
tenant's own configuration. Everything else is canned. chi's 404 and 405
get handlers so the envelope has no exceptions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `ApiError.code` — the client reads the envelope

**Files:**
- Modify: `web/src/api/client.ts`
- Create: `web/src/api/client.test.ts`

**Interfaces:**
- Consumes: the envelope from Task 2.
- Produces: `class ApiError { readonly status: number; readonly code: string | null }`. Task 6 reads `error.code`.

- [ ] **Step 1: Write the failing test**

Create `web/src/api/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiGet, apiPost } from "./client";

function stubFetch(status: number, body: unknown, ok = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok,
        status,
        json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
      }),
    ),
  );
}

describe("the refusal envelope", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the code off a refusal", async () => {
    stubFetch(409, { code: "TY003", message: "a unit in this submit was already inspected within 6 hours" });

    const err = await apiPost("/api/inspections", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("TY003");
  });

  it("distinguishes a conflict from the duplicate window", async () => {
    stubFetch(409, { code: "conflict", message: "the submission conflicts with data already recorded" });

    const err = (await apiPost("/api/inspections", {}).catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(409);
    expect(err.code).toBe("conflict");
  });

  // A proxy or gateway refusal carries no envelope. An error path that throws
  // while reporting an error is the one failure the outbox cannot absorb.
  it("reads a body with no envelope as a null code", async () => {
    stubFetch(502, { nothing: "useful" });

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
  });

  it("reads an unparseable body as a null code", async () => {
    stubFetch(500, new SyntaxError("Unexpected token < in JSON"));

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(500);
    expect(err.code).toBeNull();
  });

  it("reads a non-string code as null rather than trusting it", async () => {
    stubFetch(422, { code: 42 });

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd web && npx vitest run src/api/client.test.ts
```

Expected: FAIL — `code` is undefined on `ApiError`.

- [ ] **Step 3: Implement**

In `web/src/api/client.ts`, extend the class and add the parser:

```ts
// The status is the outbox's decision (FR-OFF-012 vs FR-OFF-013); the code is
// the reason, which is what decides the sentence a driver reads. A 409 alone
// cannot separate FR-INS-038's duplicate window from any other conflict
// (ADR-0012).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A proxy, a gateway or a browser-generated failure carries no envelope, so an
// absent or unreadable code is null rather than a throw: an error path that
// fails while reporting a failure loses the inspection the outbox is holding.
async function refusalCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "code" in body) {
      const { code } = body as { code: unknown };
      return typeof code === "string" ? code : null;
    }
  } catch {
    return null;
  }
  return null;
}
```

Then in both `apiGet` and `apiPost`, replace the throw:

```ts
  if (!res.ok) {
    throw new ApiError(res.status, `GET ${path} failed: ${res.status}`, await refusalCode(res));
  }
```

and the same in `apiPost` with `POST`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run src/api/client.test.ts
```

Expected: PASS, all five.

- [ ] **Step 5: Typecheck**

```bash
cd web && npx tsc --noEmit
```

Expected: clean. If `refusalCode` trips `no-unsafe-assignment`, the narrowing is wrong — do not reach for `any` or a non-null assertion.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts
git commit -m "$(cat <<'EOF'
feat(capture): TYRE-78 read the refusal code off the envelope

ApiError carries the reason as well as the status. A body with no
envelope reads as a null code: a proxy refusal carries none, and an
error path that throws while reporting an error loses the inspection
the outbox is holding.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Tell the driver what actually happened

**Files:**
- Modify: `web/src/capture/outbox.ts` (the `OutboxEntry` interface, `queueDraft`, `attemptSend`)
- Modify: `web/src/capture/CaptureFlow.tsx:37`, `:265-271`, `:293`
- Modify: `web/src/capture/CaptureDone.tsx`
- Test: `web/src/capture/outbox.test.ts`, `web/src/capture/CaptureFlow.test.tsx`

**Interfaces:**
- Consumes: `ApiError.code` from Task 5.
- Produces: `OutboxEntry.lastCode: string | null`; `CaptureDone({ state, lastCode })`.

`lastStatus` stays on the entry — the outbox indicator and diagnostics use it, and `classify()` still keys on it. `CaptureDone` stops reading it.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/capture/outbox.test.ts`, immediately after the existing test `"stops retrying a permanent refusal but keeps the inspection"` (around `:173`). It uses that test's `queueOne()` helper:

```ts
  // The status alone cannot separate FR-INS-038's window from any other
  // conflict, and the two send a driver to different conversations.
  it("records the refusal code beside the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ code: "TY003", message: "already inspected" }),
      }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    const [failed] = await listOutbox();
    expect(failed.state).toBe("failed");
    expect(failed.lastStatus).toBe(409);
    expect(failed.lastCode).toBe("TY003");
  });
```

Then add one line to the existing permanent-refusal test above it, whose stub answers `{}` and therefore carries no envelope:

```ts
    expect(failed.lastCode).toBeNull();
```

In `web/src/capture/CaptureFlow.test.tsx`, widen `stubApi` at `:114` to carry a code:

```ts
function stubApi(submitStatus = 201, served: CaptureContext[] = [context], submitCode: string | null = null) {
  const byId = new Map(served.map((c) => [c.vehicleId, c]));
  const api = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      return Promise.resolve({
        ok: submitStatus < 400,
        status: submitStatus,
        json: () =>
          Promise.resolve(
            submitStatus < 400 ? { inspectionId: "i1" } : { code: submitCode, message: "refused" },
          ),
      });
    }
    const asked = byId.get(url.split("/").pop() ?? "");
    return Promise.resolve(
      asked
        ? { ok: true, status: 200, json: () => Promise.resolve(asked) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) },
    );
  });
  vi.stubGlobal("fetch", api);
  return api;
}
```

Update the existing test `"presents a duplicate-window refusal without losing the inspection"` (`:229`) so its stub carries the code: `stubApi(409, [context], "TY003")`. Its assertions are unchanged and must still pass.

Then add its opposite immediately after it, following the same drive sequence — `newUser()`, `renderFlow()`, `capturePosition(user)`, the two buttons. The file has no combined submit helper; do not invent one:

```ts
  // FR-INS-038's window is the one refusal a driver resolves by naming that
  // vehicle to the office. Any other conflict is a different conversation, and
  // naming the wrong one sends them to argue about an inspection that never
  // happened (NFR-USE-005).
  it("does not blame the duplicate window for an unrelated conflict", async () => {
    const user = newUser();
    stubApi(409, [context], "conflict");
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not accept/i);
    expect(alert).not.toHaveTextContent(/already inspected/i);
    expect(await db.table("outbox").count()).toBe(1);
  });
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
cd web && npx vitest run src/capture/outbox.test.ts src/capture/CaptureFlow.test.tsx
```

Expected: FAIL — `lastCode` undefined; the new conflict test finds "already inspected".

- [ ] **Step 3: Carry the code through the outbox**

In `web/src/capture/outbox.ts`, add to `OutboxEntry` beneath `lastStatus`:

```ts
  // The refusal's reason (ADR-0012). The status alone cannot separate
  // FR-INS-038's duplicate window from any other conflict, and the two send a
  // driver to different conversations. Null where the refusal carried no
  // envelope, and on entries queued before this field existed.
  lastCode: string | null;
```

In `queueDraft`, add `lastCode: null` beside `lastStatus: null`. In `attemptSend`'s catch block, add:

```ts
      lastCode: error instanceof ApiError ? error.code : null,
```

Leave `lastError` and `classify()` exactly as they are.

- [ ] **Step 4: Thread it to the done screen**

In `web/src/capture/CaptureFlow.tsx`, change the outcome type at `:37` from `lastStatus: number | null` to `lastCode: string | null`, then the two constructions at `:265-271`:

```tsx
          still === undefined
            ? { state: "sent", lastCode: null }
            : {
                state: still.state === "failed" ? "failed" : "queued",
                lastCode: still.lastCode ?? null,
              },
```

The `?? null` is required: an entry queued before this field existed reads back `undefined`, not `null` (Dexie stores the object as written).

And at `:293`:

```tsx
    body = <CaptureDone state={outcome.state} lastCode={outcome.lastCode} />;
```

- [ ] **Step 5: Branch on the reason**

In `web/src/capture/CaptureDone.tsx`, change the prop and the final block:

```tsx
export function CaptureDone({
  state,
  lastCode,
}: {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
}) {
```

```tsx
  // FR-OFF-013: a supported recovery action, in plain language (NFR-USE-005).
  // TY003 is FR-INS-038's window and the one refusal a driver can resolve by
  // naming the vehicle to the office. Every other refusal is a different
  // conversation, so it gets the honest general answer rather than a specific
  // wrong one.
  return (
    <section className="cap-screen cap-done" role="alert">
      <p className="cap-done-mark cap-done-mark--stop" aria-hidden="true">
        !
      </p>
      <h1 className="cap-done-title">This one needs the office</h1>
      <p className="cap-done-body">
        {lastCode === "TY003"
          ? "This vehicle was already inspected a short while ago. Your readings are saved — call the tyre office and they can accept it."
          : "The office could not accept this inspection. Your readings are saved — call the tyre office."}
      </p>
      <BackToWork />
    </section>
  );
}
```

- [ ] **Step 6: Run the web suite**

```bash
cd web && npx vitest run && npx tsc --noEmit
```

Expected: PASS throughout. `CaptureDiagram`, `PositionSheet` and the rest are untouched; a failure there means Step 4 changed a shared type by accident.

- [ ] **Step 7: Run the full gate, then the browser gate**

```bash
make check
make e2e
```

`web/e2e/capture.spec.ts:341` drives a real duplicate submit and asserts `/already inspected/i`. It now proves the code survives database, API, outbox and screen. It must pass unchanged; if it fails, the code is being lost at a hop, not the test being wrong.

If `make e2e` cannot run in this environment, say so explicitly in the PR rather than letting it pass silently.

- [ ] **Step 8: Commit**

```bash
git add web/src/capture/
git commit -m "$(cat <<'EOF'
feat(capture): TYRE-78 name the duplicate window only when it happened

CaptureDone branches on the refusal code, not the status. A 409 from any
other conflict told a driver their vehicle was already inspected today
and sent them to argue about an inspection that never happened
(FR-INS-038, NFR-USE-005, FR-OFF-013). The outbox still treats both as
permanent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Close out the documentation

**Files:**
- Modify: `docs/implementation-order.md` (the B3 section)
- Modify: `api/CLAUDE.md:32`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Correct the B3 paragraph**

`docs/implementation-order.md`'s B3 section says:

> TYRE-77's constraint is that the five `TY0xx` messages are deliberately human-facing and asserted by name in `db/tests/004_tests.sql` — the fix must preserve them while canning everything else.

Two errors in one sentence. There are **ten** `TY0xx` codes, `TY001`–`TY010`; B1 added `TY008` and `TY009` in migrations `000024` and `000025`. And `004_tests.sql` asserts the **SQLSTATEs** by name, not the messages — it contains no message-text assertion at all. Rewrite the sentence to say both accurately, and note that the messages the fix preserves are the five reachable through `app.submit_inspection` (`TY003`–`TY007`).

- [ ] **Step 2: Record B3 as delivered**

Follow the shape B1 and B2 use in the same file: mark the heading **— delivered**, cite the plan path, and give the delivery table. Include the TY008/TY009 deferral as a note B4 will read, and update the "Open and correctly scoped" table's TYRE-77 and TYRE-78 rows to struck-through **closed by B3**, as the TYRE-74/TYRE-82 rows already are.

- [ ] **Step 3: Reword `api/CLAUDE.md`**

`api/CLAUDE.md:32` reads "A handler never writes its own `http.Error` for either case." The rule is still right and still worth stating; the call it names exists nowhere after Task 4. Reword to `writeError`, and add a sentence that every refusal goes through it so one envelope covers the API (ADR-0012). Keep it in the present tense — the comment checker does not scan `.md`, but the file is read as current instruction, not as history.

- [ ] **Step 4: Run the gate**

```bash
make check
```

Expected: green, including `scripts/check-comment-style.mjs` over every tracked file. Note that the checker sees only tracked files, so `git add` before trusting a green run.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs/implementation-order.md api/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: TYRE-77 record B3 as delivered

The B3 paragraph named five TY0xx codes where there are ten, and said
004_tests.sql asserts the messages where it asserts the SQLSTATEs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push -u origin TYRE-77-refusal-contract
```

Open the PR against `develop`. **Do not merge** — merges happen in the GitHub web UI, by a human. The PR body must state which of `make check` and `make e2e` were run and their outcome, and must carry the TY008/TY009 deferral as a note for B4.

- [ ] **Step 6: Run the comment audit**

Run `/comment-audit` before handing the branch over, per `CLAUDE.md`'s closing-out rule.

---

## Self-review

**Spec coverage.** The envelope → Task 2. The code table, both halves → Tasks 3 and 4. The message rule → Task 3. `errVehicleNotVisible` carrying `TY007` → Task 3 (constant) and Task 4 (site). chi 404/405 → Task 4. The client → Tasks 5 and 6. TY008/TY009 deferral → Tasks 1 and 7 (recorded, not implemented, which is the deliverable). Testing → every task's own steps, with `Content-Type` in Tasks 2 and 4 and the `reading_tyre_id_fkey` assertion in Task 3. Docs → Task 7. ADR → Task 1.

**Type consistency.** `refusal{status, code, message}` is defined in Task 3 and used in Tasks 3 and 4 only. `errorBody{Code, Message}` is defined in Task 2 and read in Task 4's tests. `writeError(ctx, w, status, code, message)` has one signature throughout. `ApiError.code` is `string | null` in Tasks 5 and 6; `OutboxEntry.lastCode` is `string | null` in Task 6; `CaptureDone`'s prop is `lastCode`, never `lastStatus`, after Task 6 Step 5.

**Corrections made during this review, so they are not rediscovered.** The first draft put every Go test in `httpapi_test.go`; that file is `package httpapi_test` and cannot see one unexported identifier this plan adds, so the white-box tests moved to `refusal_internal_test.go` (decision 7). It also asserted the 404 fallback against `/api/nothing-here`, which `requireActor` answers 401 before chi's `NotFound` is reached — the path is now outside `/api`. And Task 6's outbox test named fixtures that file does not have; it uses the `queueOne()` helper the neighbouring test uses.

**Known risks.** Task 6 Step 4 changes a type shared by `CaptureFlow`'s outcome state; if another component reads `outcome.lastStatus`, `tsc` catches it at Step 6, which is why the typecheck is a step and not an afterthought. Task 4 converts sites that existing integration tests already exercise — a status changing there means the conversion is wrong, not the test.
