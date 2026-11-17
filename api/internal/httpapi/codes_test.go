package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

// receiveSet posts one GENERATED receive of quantity tyres and answers the
// tyres it minted and their receipt.
func (f receiptFixture) receiveSet(t *testing.T, ctx context.Context, admin *pgx.Conn, quantity int) (receivedTyresBody, uuid.UUID) {
	t.Helper()
	rec := post(t, f.h, "/api/tyres", f.tenantID.String(), f.controller.String(),
		f.cat.body(t, map[string]any{"quantity": quantity}))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var out receivedTyresBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Tyres, quantity)
	var receipt uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT receipt_id FROM app.tyre WHERE id = $1`, out.Tyres[0].ID).Scan(&receipt))
	return out, receipt
}

// register reads GET /api/tyres with query as the fixture's controller.
func (f receiptFixture) register(t *testing.T, query string) tyresListBody {
	t.Helper()
	rec := get(t, f.h, "/api/tyres"+query, f.tenantID.String(), f.controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body tyresListBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

// codePending is each listed tyre's flag by id; a tyre the response carries
// no flag for fails the test.
func codePending(t *testing.T, body tyresListBody) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, ty := range body.Tyres {
		require.NotNil(t, ty.CodePending, "tyre %s carries no codePending", ty.DisplayCode)
		out[ty.ID] = *ty.CodePending
	}
	return out
}

// codesToMarkOf is the response's count; a response that carries none
// fails the test.
func codesToMarkOf(t *testing.T, body tyresListBody) int {
	t.Helper()
	require.NotNil(t, body.CodesToMark, "the register carries no codesToMark")
	return *body.CodesToMark
}

func markedIDs(t *testing.T, rec []byte) []string {
	t.Helper()
	var out receivedTyresBody
	require.NoError(t, json.Unmarshal(rec, &out))
	ids := []string{}
	for _, ty := range out.Tyres {
		ids = append(ids, ty.ID)
	}
	return ids
}

// U224: who records a marking is ManageAssets, which a driver and a
// technician do not hold (DoD 3).
func TestMarkCodeRoutesRefuseADriverAndATechnician(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "mark-roles")
	tyres, receipt := f.receiveSet(t, ctx, admin, 1)

	for _, role := range []auth.Role{auth.RoleDriver, auth.RoleTechnician} {
		user := plantUser(t, ctx, admin, f.tenantID, role)
		for _, path := range []string{
			"/api/tyres/" + tyres.Tyres[0].ID + "/code-marked",
			"/api/tyre-receipts/" + receipt.String() + "/codes-marked",
		} {
			t.Run(string(role)+" "+path, func(t *testing.T) {
				rec := post(t, f.h, path, f.tenantID.String(), user.String(), `{}`)
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			})
		}
	}
	require.Equal(t, 1, codesToMarkOf(t, f.register(t, "")), "a refused marking marks nothing")
}

// U224 names the depot manager beside the controller and the administrator:
// marking follows the capability, not a role.
func TestMarkCodeAsADepotManager(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "mark-depot-manager")
	tyres, _ := f.receiveSet(t, ctx, admin, 1)
	manager := plantUser(t, ctx, admin, f.tenantID, auth.RoleDepotManager)

	rec := post(t, f.h, "/api/tyres/"+tyres.Tyres[0].ID+"/code-marked", f.tenantID.String(), manager.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []string{tyres.Tyres[0].ID}, markedIDs(t, rec.Body.Bytes()))
}

func TestMarkCodeOnSidewallMarksOneTyre(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "mark-one")
	tyres, _ := f.receiveSet(t, ctx, admin, 2)
	marked, other := tyres.Tyres[0], tyres.Tyres[1]

	rec := post(t, f.h, "/api/tyres/"+marked.ID+"/code-marked", f.tenantID.String(), f.controller.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out receivedTyresBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Tyres, 1)
	require.Equal(t, marked.ID, out.Tyres[0].ID)
	require.Equal(t, marked.DisplayCode, out.Tyres[0].DisplayCode)

	body := f.register(t, "")
	flags := codePending(t, body)
	require.False(t, flags[marked.ID], "the marked tyre still reads pending")
	require.True(t, flags[other.ID], "the unmarked tyre no longer reads pending")
	require.Equal(t, 1, codesToMarkOf(t, body))
}

func TestMarkCodesOnAReceiptMarksTheSet(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "mark-receipt")
	tyres, receipt := f.receiveSet(t, ctx, admin, 3)
	today := tenantToday(t, ctx, admin, f.tenantID)

	rec := post(t, f.h, "/api/tyre-receipts/"+receipt.String()+"/codes-marked", f.tenantID.String(),
		f.controller.String(), `{"markedOn":"`+today+`"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	want := []string{}
	for _, ty := range tyres.Tyres {
		want = append(want, ty.ID)
	}
	require.ElementsMatch(t, want, markedIDs(t, rec.Body.Bytes()))
	require.Equal(t, 0, codesToMarkOf(t, f.register(t, "")))
}

func TestMarkCodeRefusalIsTY012(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "mark-refused")
	tyres, _ := f.receiveSet(t, ctx, admin, 1)
	path := "/api/tyres/" + tyres.Tyres[0].ID + "/code-marked"

	rec := post(t, f.h, path, f.tenantID.String(), f.controller.String(), `{"markedOn":"not-a-date"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Equal(t, "markedOn must be a date as YYYY-MM-DD", ref.Message)
	require.Equal(t, 1, codesToMarkOf(t, f.register(t, "")), "a refused date marks nothing")

	rec = post(t, f.h, path, f.tenantID.String(), f.controller.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = post(t, f.h, path, f.tenantID.String(), f.controller.String(), `{}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, tyres.Tyres[0].DisplayCode+" has no code waiting to be marked on its sidewall", ref.Message)
}

// Rule 1: another fleet's tyre and receipt read as no such row, the words a
// missing id gets.
func TestMarkCodeCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	a := plantReceiptFixture(t, ctx, s, admin, "mark-tenant-a")
	tyres, receipt := a.receiveSet(t, ctx, admin, 1)
	b := plantReceiptFixture(t, ctx, s, admin, "mark-tenant-b")

	for _, tt := range []struct{ path, want string }{
		{"/api/tyres/" + tyres.Tyres[0].ID + "/code-marked", "no such tyre in this fleet"},
		{"/api/tyre-receipts/" + receipt.String() + "/codes-marked", "no such receipt in this fleet"},
	} {
		t.Run(tt.path, func(t *testing.T) {
			rec := post(t, b.h, tt.path, b.tenantID.String(), b.controller.String(), `{}`)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "TY012", ref.Code)
			require.Equal(t, tt.want, ref.Message)
		})
	}
	require.Equal(t, 1, codesToMarkOf(t, a.register(t, "")), "the other fleet's attempts marked nothing")
}

// The register reads app.v_tyre_code_to_mark for the flag, the filter and
// the count, so none is a second copy of the rule (spec, Anti-goals).
func TestListTyresFiltersCodesToMark(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "codes-filter")
	priced, pricedReceipt := f.receiveSet(t, ctx, admin, 1)
	unpriced, _ := f.receiveSet(t, ctx, admin, 1)
	done, _ := f.receiveSet(t, ctx, admin, 1)
	rec := post(t, f.h, "/api/tyres/"+done.Tyres[0].ID+"/code-marked", f.tenantID.String(), f.controller.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = post(t, f.h, "/api/tyre-receipts/"+pricedReceipt.String()+"/invoice", f.tenantID.String(),
		f.controller.String(), `{"price":"4500.00"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	ids := func(body tyresListBody) []string {
		out := []string{}
		for _, ty := range body.Tyres {
			out = append(out, ty.ID)
		}
		return out
	}
	pending := f.register(t, "?codesToMark=true")
	require.ElementsMatch(t, []string{priced.Tyres[0].ID, unpriced.Tyres[0].ID}, ids(pending))
	require.Equal(t, 2, codesToMarkOf(t, pending))
	both := f.register(t, "?codesToMark=true&awaitingCost=true")
	require.ElementsMatch(t, []string{unpriced.Tyres[0].ID}, ids(both))
	require.Equal(t, 2, codesToMarkOf(t, both), "the count is the queue's, whatever the filter")

	// Under FREE the code was read off the sidewall, so nothing waits.
	freeTenant, _ := plantTenant(t, ctx, admin, "codes-free")
	cat := plantReceiveCatalogue(t, ctx, admin, freeTenant)
	controller := plantUser(t, ctx, admin, freeTenant, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec = post(t, h, "/api/tyres", freeTenant.String(), controller.String(),
		cat.body(t, map[string]any{"displayCode": "FREE-" + uuid.NewString()[:8]}))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = get(t, h, "/api/tyres", freeTenant.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var free tyresListBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &free))
	require.Len(t, free.Tyres, 1)
	require.False(t, codePending(t, free)[free.Tyres[0].ID])
	require.Equal(t, 0, codesToMarkOf(t, free))
}
