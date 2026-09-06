package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

// plantVoidableInspection plants one SYNCED inspection with a reading and a
// measurement, in the single transaction TYRE-145's inspection_is_sealed
// trigger requires (plantCaptureFixture's own comment: the trigger keys on
// the inspection's own created_at against transaction_timestamp(), so a
// reading appended as a later autocommit statement is refused TY020).
func plantVoidableInspection(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, vehicleID, driverID, positionID uuid.UUID) uuid.UUID {
	t.Helper()
	tx, err := admin.Begin(ctx)
	require.NoError(t, err)

	var inspID, readingID uuid.UUID
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
		 VALUES ($1, $2, $3, $4, now(), now(), 1000) RETURNING id`,
		tenantID, vehicleID, driverID, uuid.New(),
	).Scan(&inspID))
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		tenantID, inspID, vehicleID, positionID,
	).Scan(&readingID))
	_, err = tx.Exec(ctx,
		`INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, tread_mm, position)
		 VALUES ($1, $2, 1, 10.0, 'CENTRE'::app.tread_position)`,
		tenantID, readingID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	return inspID
}

func voidPath(inspectionID string) string {
	return "/api/inspections/" + inspectionID + "/void"
}

// decodeRefusal reuses admin_test.go's refusalBody (ADR-0012's one envelope
// shape) rather than redeclaring it.
func decodeRefusal(t *testing.T, body []byte) refusalBody {
	t.Helper()
	var out refusalBody
	require.NoError(t, json.Unmarshal(body, &out))
	return out
}

// TestVoidInspection covers FR-INS-012's write end to end: the capability
// gate, the trimmed-and-mandatory reason, the audit row under the acting
// controller, finality (a second void is TY019), and tenant isolation (a
// foreign inspection is TY012, never a silent no-op).
func TestVoidInspection(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)

	tenantID, mine, _, leftPos, _, _ := plantUnitFixture(t, ctx, admin, "void")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	t.Run("driver is refused: VoidInspection is CONTROLLER or higher (FR-INS-012)", func(t *testing.T) {
		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		rec := post(t, h, voidPath(inspID.String()), tenantID.String(), driver.String(), `{"reason":"wrong vehicle"}`)
		require.Equal(t, http.StatusForbidden, rec.Code)
		require.Equal(t, "forbidden", decodeRefusal(t, rec.Body.Bytes()).Code)

		var state string
		require.NoError(t, admin.QueryRow(ctx, `SELECT state FROM app.inspection WHERE id = $1`, inspID).Scan(&state))
		require.Equal(t, "SYNCED", state, "a refused void must not touch the row")
	})

	t.Run("controller voids with a reason: 204, trimmed, audited under the actor", func(t *testing.T) {
		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		rec := post(t, h, voidPath(inspID.String()), tenantID.String(), controller.String(), `{"reason":"  wrong vehicle  "}`)
		require.Equal(t, http.StatusNoContent, rec.Code)

		var state, reason string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT state, void_reason FROM app.inspection WHERE id = $1`, inspID,
		).Scan(&state, &reason))
		require.Equal(t, "VOIDED", state)
		require.Equal(t, "wrong vehicle", reason)

		var n int
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT count(*) FROM app.audit_log
			  WHERE entity_type = 'inspection' AND entity_id = $1
			    AND action = 'UPDATE' AND actor_id = $2`,
			inspID, controller,
		).Scan(&n))
		require.Equal(t, 1, n, "the void is audited exactly once, under the acting controller")
	})

	t.Run("a second void is refused TY019: a void is final", func(t *testing.T) {
		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		first := post(t, h, voidPath(inspID.String()), tenantID.String(), controller.String(), `{"reason":"wrong vehicle"}`)
		require.Equal(t, http.StatusNoContent, first.Code)

		second := post(t, h, voidPath(inspID.String()), tenantID.String(), controller.String(), `{"reason":"again"}`)
		require.Equal(t, http.StatusUnprocessableEntity, second.Code)
		body := decodeRefusal(t, second.Body.Bytes())
		require.Equal(t, "TY019", body.Code)
		require.Equal(t, "this inspection is already voided", body.Message)
	})

	t.Run("a blank reason is refused before any transaction opens (requiredText)", func(t *testing.T) {
		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		rec := post(t, h, voidPath(inspID.String()), tenantID.String(), controller.String(), `{"reason":"   "}`)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		body := decodeRefusal(t, rec.Body.Bytes())
		require.Equal(t, "invalid_submission", body.Code)
		require.Equal(t, "reason is required", body.Message)

		var state string
		require.NoError(t, admin.QueryRow(ctx, `SELECT state FROM app.inspection WHERE id = $1`, inspID).Scan(&state))
		require.Equal(t, "SYNCED", state)
	})

	// maxTextLen on reason, mirroring TestSetUnitStatusReasonIsLengthCapped
	// and TestFitmentTextFieldsAreLengthCapped: requiredText answers presence,
	// not size, so the cap is the handler's own check (inspections.go).
	t.Run("reason over maxTextLen is refused before any transaction opens", func(t *testing.T) {
		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		long := strings.Repeat("x", 201)
		rec := post(t, h, voidPath(inspID.String()), tenantID.String(), controller.String(),
			fmt.Sprintf(`{"reason":%q}`, long))
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
		body := decodeRefusal(t, rec.Body.Bytes())
		require.Equal(t, "invalid_submission", body.Code)
		require.Equal(t, "reason is too long", body.Message)

		var state string
		require.NoError(t, admin.QueryRow(ctx, `SELECT state FROM app.inspection WHERE id = $1`, inspID).Scan(&state))
		require.Equal(t, "SYNCED", state, "a refused void must not touch the row")
	})

	t.Run("reason at exactly maxTextLen reaches the gate and lands", func(t *testing.T) {
		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		atCap := strings.Repeat("x", 200)
		rec := post(t, h, voidPath(inspID.String()), tenantID.String(), controller.String(),
			fmt.Sprintf(`{"reason":%q}`, atCap))
		require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

		var state, reason string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT state, void_reason FROM app.inspection WHERE id = $1`, inspID,
		).Scan(&state, &reason))
		require.Equal(t, "VOIDED", state)
		require.Equal(t, atCap, reason)
	})

	t.Run("another tenant's inspection is invisible: TY012, not a silent no-op", func(t *testing.T) {
		tenantB, mineB, _, leftPosB, _, _ := plantUnitFixture(t, ctx, admin, "void-b")
		driverB := plantUser(t, ctx, admin, tenantB, auth.RoleDriver)
		controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
		_ = mineB
		_ = leftPosB
		_ = driverB

		inspID := plantVoidableInspection(t, ctx, admin, tenantID, mine, driver, leftPos)
		rec := post(t, h, voidPath(inspID.String()), tenantB.String(), controllerB.String(), `{"reason":"not mine"}`)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		require.Equal(t, "TY012", decodeRefusal(t, rec.Body.Bytes()).Code)

		var state string
		require.NoError(t, admin.QueryRow(ctx, `SELECT state FROM app.inspection WHERE id = $1`, inspID).Scan(&state))
		require.Equal(t, "SYNCED", state, "tenant A's row is unchanged by tenant B's refused attempt")
	})

	t.Run("a malformed inspection id is bad_request before the id is even looked up", func(t *testing.T) {
		rec := post(t, h, voidPath("not-a-uuid"), tenantID.String(), controller.String(), `{"reason":"wrong vehicle"}`)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.Equal(t, "bad_request", decodeRefusal(t, rec.Body.Bytes()).Code)
	})
}
