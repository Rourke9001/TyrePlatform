// The fitment surface (TYRE-92): the three writes that move a casing on and
// off a unit, over the functions in migration 000033. Everything a fitment
// means — which states a casing may be fitted from, whether the position
// belongs to the unit, the retread and dual-mate warnings, the removal
// vocabulary, that a rotation is all of its moves or none of them — is
// app.fit_tyre's, app.remove_tyre's and app.rotate_tyres' alone. What
// follows validates the shape of a request and reads back a result
// (ADR-0013 decision 5); it decides nothing about tyres.
package httpapi

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

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
// 22007/22008 is in no map here, so withActor would answer 500 for what is
// really a client typo. The parsed value is what gets bound, not the text it
// came from: pgx encodes a time.Time as a timestamptz itself, so the instant
// the function acts on is exactly the one validated here.
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
// stays in SQL — listTyres validates its on the same way. Without this,
// "yesterday" reaches the cast raw and Postgres's 22007/22008, which is in
// no map here, answers 500 for a client typo. A nil raw stays nil so the
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

// fitTyreRequest is app.fit_tyre's body. Odometer is *int64 so a unit with
// none sends nothing rather than a zero reading (000025 exempts a trailer),
// and OccurredAt is *string so an absent instant reaches the function's own
// now() default instead of a Go clock's idea of the same moment.
type fitTyreRequest struct {
	TyreID     string `json:"tyreId"`
	PositionID string `json:"positionId"`
	TreadMm    string `json:"treadMm"`
	// D13: which sidewall carries the mark, distinct from the position's
	// left/right and from reading orientation; 000030 holds the rationale.
	MountOrientation string  `json:"mountOrientation"`
	Odometer         *int64  `json:"odometer"`
	OccurredAt       *string `json:"occurredAt"`
	Reason           *string `json:"reason"`
}

// fitTyreArgs is the validated request: the two ids parsed, the two required
// strings present, the free-text note held to maxTextLen. Nothing here narrows
// a value — the mount orientation is checked by the enum cast, and the tread's
// range by app.fit_tyre.
type fitTyreArgs struct {
	tyreID           uuid.UUID
	positionID       uuid.UUID
	treadMm          string
	mountOrientation string
	occurredAt       *time.Time
	reason           *string
}

func (b fitTyreRequest) validate() (fitTyreArgs, error) {
	var a fitTyreArgs
	var err error
	if a.tyreID, err = uuidField("tyreId", b.TyreID); err != nil {
		return a, err
	}
	if a.positionID, err = uuidField("positionId", b.PositionID); err != nil {
		return a, err
	}
	if a.treadMm, err = requiredText("treadMm", b.TreadMm); err != nil {
		return a, err
	}
	if a.mountOrientation, err = requiredText("mountOrientation", b.MountOrientation); err != nil {
		return a, err
	}
	if a.occurredAt, err = instantField("occurredAt", b.OccurredAt); err != nil {
		return a, err
	}
	if a.reason, err = text("reason", b.Reason); err != nil {
		return a, err
	}
	return a, nil
}

// fitWarningJSON is one entry of app.fit_tyre's warnings array, forwarded
// verbatim. A warning is advice the fleet's own configuration produced
// (FR-FIT-006, FR-FIT-020, U11) — it is never a refusal, and the fit that
// carried it has already landed by the time the client reads one.
type fitWarningJSON struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type fitTyreResponse struct {
	FitmentID string           `json:"fitmentId"`
	Warnings  []fitWarningJSON `json:"warnings"`
}

// decodeFitWarnings reads app.fit_tyre's warnings column into the wire shape,
// answering an empty list — never a nil one — for every way the column can say
// "no warnings". app.fit_tyre answers '[]'::jsonb today, so the other two arms
// guard a contract rather than a case seen in practice: a SQL NULL scans as a
// nil []byte that json.Unmarshal refuses outright, and a jsonb `null` literal
// decodes into a nil slice. Either would reach the capture and fitment
// screens, which branch on the list's length, as an absent list rather than an
// empty one — and the first would have answered 500 for a fit that landed.
func decodeFitWarnings(raw []byte) ([]fitWarningJSON, error) {
	if len(raw) == 0 {
		return []fitWarningJSON{}, nil
	}
	var out []fitWarningJSON
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decoding fit warnings: %w", err)
	}
	if out == nil {
		return []fitWarningJSON{}, nil
	}
	return out, nil
}

// fitTyre is FR-FIT-001's write. The unit id is the URL's; the casing, the
// position and the reading are the body's. Occupancy is deliberately not
// pre-checked anywhere: one_open_fitment_per_position and
// one_open_fitment_per_tyre (000001) are the only implementation, their
// 23505 reaches conflictCodes, and a check here would be a second one that a
// raw INSERT walks past (FR-FIT-004).
func fitTyre(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var body fitTyreRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		args, err := body.validate()
		if refuseInvalid(w, r, err) {
			return
		}

		var fitmentID uuid.UUID
		warnings := []fitWarningJSON{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			// TY009, TY012 and TY014 arrive via refusalForPgError with their
			// messages intact; the two occupancy indexes arrive as 23505.
			var raw []byte
			if err := tx.QueryRow(ctx,
				`SELECT fitment_id, warnings
				   FROM app.fit_tyre($1, $2, $3, $4::numeric, $5::app.mount_orientation,
				                     $6, COALESCE($7::timestamptz, now()), $8)`,
				args.tyreID, vehicleID, args.positionID, args.treadMm, args.mountOrientation,
				body.Odometer, args.occurredAt, args.reason,
			).Scan(&fitmentID, &raw); err != nil {
				return fmt.Errorf("fitting tyre %s to unit %s: %w", args.tyreID, vehicleID, err)
			}
			decoded, decodeErr := decodeFitWarnings(raw)
			if decodeErr != nil {
				return decodeErr
			}
			warnings = decoded
			return nil
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated,
			fitTyreResponse{FitmentID: fitmentID.String(), Warnings: warnings})
	}
}

// removeFitmentRequest is app.remove_tyre's body. Reason is not checked for
// presence here: the vocabulary is tenant configuration (rule 5,
// FR-FIT-008), so the only place that can say what a valid reason is — and
// name the fleet's own list in the refusal — is the function.
type removeFitmentRequest struct {
	Reason         string  `json:"reason"`
	TreadMm        string  `json:"treadMm"`
	Odometer       *int64  `json:"odometer"`
	OccurredAt     *string `json:"occurredAt"`
	BackdateReason *string `json:"backdateReason"`
}

// removeFitment is FR-FIT-007's write. It answers 204: a removal produces no
// projection a caller cannot already read from the unit, and the fitment id
// it closed is the one in the URL. A second removal, a reason outside the
// fleet's list, a distance running backwards and a cross-tenant fitment are
// all app.remove_tyre's refusals (ADR-0013 decision 5) — a cross-tenant id
// meets the same "no such fitment in this fleet" a genuinely missing one
// does, because RLS makes the two indistinguishable by construction.
func removeFitment(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		fitmentID, ok := pathID(w, r, "fitmentID")
		if !ok {
			return
		}
		var body removeFitmentRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		treadMm, err := requiredText("treadMm", body.TreadMm)
		if refuseInvalid(w, r, err) {
			return
		}
		occurredAt, err := instantField("occurredAt", body.OccurredAt)
		if refuseInvalid(w, r, err) {
			return
		}
		// Length only, and no trim: which reasons a fleet accepts is
		// app.remove_tyre's list to check (rule 5), and trimming here would
		// hand the function a token the caller did not send. maxTextLen is the
		// same transport bound every free-text field on a write carries — a
		// reason longer than the whole vocabulary can spell is not one this
		// side needs to open a transaction to refuse.
		if len(body.Reason) > maxTextLen {
			refuseInvalid(w, r, invalid("reason", "is too long"))
			return
		}
		backdateReason, err := text("backdateReason", body.BackdateReason)
		if refuseInvalid(w, r, err) {
			return
		}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`SELECT app.remove_tyre($1, $2, $3::numeric, $4,
				                        COALESCE($5::timestamptz, now()), $6)`,
				fitmentID, body.Reason, treadMm, body.Odometer,
				occurredAt, backdateReason); err != nil {
				return fmt.Errorf("removing fitment %s: %w", fitmentID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// rotateMove is one casing changing position within a unit. The wire is
// camelCase like every other body here; payload below translates it to the
// snake_case keys app.rotate_tyres reads out of its jsonb argument.
type rotateMove struct {
	TyreID       string `json:"tyreId"`
	ToPositionID string `json:"toPositionId"`
	TreadMm      string `json:"treadMm"`
}

type rotateRequest struct {
	Moves      []rotateMove `json:"moves"`
	Odometer   *int64       `json:"odometer"`
	OccurredAt *string      `json:"occurredAt"`
}

// payload builds app.rotate_tyres' jsonb argument. The list's length is
// deliberately not checked: "a rotation is two or more moves" is the
// function's rule (TY014, FR-FIT-010), and an empty list must reach it to be
// refused there rather than by a second copy of the rule here. The slice is
// initialised so that an absent moves key is sent as the empty array it
// means; the function refuses a JSON null with the same TY014, so this is
// about saying what was asked for, not about reaching a different branch.
func (b rotateRequest) payload() ([]map[string]any, error) {
	moves := make([]map[string]any, 0, len(b.Moves))
	for i, m := range b.Moves {
		tyreID, err := uuidField(fmt.Sprintf("moves[%d].tyreId", i), m.TyreID)
		if err != nil {
			return nil, err
		}
		toPositionID, err := uuidField(fmt.Sprintf("moves[%d].toPositionId", i), m.ToPositionID)
		if err != nil {
			return nil, err
		}
		treadMm, err := requiredText(fmt.Sprintf("moves[%d].treadMm", i), m.TreadMm)
		if err != nil {
			return nil, err
		}
		moves = append(moves, map[string]any{
			"tyre_id":        tyreID.String(),
			"to_position_id": toPositionID.String(),
			"tread_mm":       treadMm,
		})
	}
	return moves, nil
}

// rotateMoveResult is one move's outcome: the casing and the fitment now
// open for it. Named rather than anonymous so a client and a test can build
// the shape (D6).
type rotateMoveResult struct {
	TyreID    string `json:"tyreId"`
	FitmentID string `json:"fitmentId"`
}

type rotateResponse struct {
	Moves []rotateMoveResult `json:"moves"`
}

// rotateTyres is FR-FIT-010's write: one set of moves within one unit,
// applied whole or not at all. The atomicity is app.rotate_tyres' own — it
// validates every move before closing any fitment — and this handler adds
// nothing to it beyond translating the request into that function's jsonb.
func rotateTyres(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var body rotateRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		validated, err := body.payload()
		if refuseInvalid(w, r, err) {
			return
		}
		occurredAt, err := instantField("occurredAt", body.OccurredAt)
		if refuseInvalid(w, r, err) {
			return
		}
		raw, err := json.Marshal(validated)
		if err != nil {
			// Unreachable in practice — every value above is a string — but
			// a handler never panics (api/CLAUDE.md), so the failure still
			// answers rather than crashing.
			slog.ErrorContext(ctx, "marshalling rotation payload", "err", err)
			writeError(ctx, w, http.StatusInternalServerError, codeInternal, msgInternal)
			return
		}

		moves := []rotateMoveResult{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			rows, err := tx.Query(ctx,
				`SELECT tyre_id, fitment_id
				   FROM app.rotate_tyres($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()))`,
				vehicleID, raw, body.Odometer, occurredAt)
			if err != nil {
				return fmt.Errorf("rotating tyres on unit %s: %w", vehicleID, err)
			}
			defer rows.Close()
			for rows.Next() {
				var tyreID, fitmentID uuid.UUID
				if err := rows.Scan(&tyreID, &fitmentID); err != nil {
					return fmt.Errorf("scanning rotated fitment: %w", err)
				}
				moves = append(moves, rotateMoveResult{
					TyreID: tyreID.String(), FitmentID: fitmentID.String()})
			}
			// A refusal raised inside the function arrives here, not from
			// Query: the rows are read lazily.
			return rows.Err()
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated, rotateResponse{Moves: moves})
	}
}
