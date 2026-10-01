package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/bearer"
	"tyreplatform/api/internal/bearer/bearertest"
	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

func bearerHandler(t *testing.T, s *store.Store) (http.Handler, *bearertest.IdP) {
	t.Helper()
	idp := bearertest.New(t)
	r := bearer.New(idp.Config())
	t.Cleanup(r.Close)
	return httpapi.New(s, r), idp
}

func getWithToken(t *testing.T, h http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set(bearer.HeaderName, "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// The app role cannot write app_user.subject (000052), so the subject is
// linked through the admin connection the way the provisioning runbook does.
func linkSubject(t *testing.T, ctx context.Context, admin *pgx.Conn, userID uuid.UUID) uuid.UUID {
	t.Helper()
	subject := uuid.New()
	_, err := admin.Exec(ctx, `UPDATE app.app_user SET subject = $2 WHERE id = $1`, userID, subject)
	require.NoError(t, err)
	return subject
}

func TestBearerALinkedUserResolves(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "bearer-linked")
	userID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	subject := linkSubject(t, ctx, admin, userID)
	h, idp := bearerHandler(t, s)

	rec := getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(subject, tenantID)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var me meBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	require.Equal(t, userID.String(), me.UserID)
	require.Equal(t, tenantID.String(), me.TenantID)
}

func TestBearerAnUnlinkedOrInactiveUserIsForbidden(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "bearer-forbidden")
	h, idp := bearerHandler(t, s)

	rec := getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(uuid.New(), tenantID)))
	require.Equal(t, http.StatusForbidden, rec.Code, "an unlinked subject")
	require.Equal(t, "forbidden", errorCode(t, rec))

	userID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	subject := linkSubject(t, ctx, admin, userID)
	rec = getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(subject, tenantID)))
	require.Equal(t, http.StatusOK, rec.Code, "control: the linked, active user resolves")
	_, err := admin.Exec(ctx, `UPDATE app.app_user SET active = false WHERE id = $1`, userID)
	require.NoError(t, err)
	rec = getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(subject, tenantID)))
	require.Equal(t, http.StatusForbidden, rec.Code, "an inactive user")
	require.Equal(t, "forbidden", errorCode(t, rec))
}

// ADR-0016 decision 5, end to end: a tenant claim naming another tenant finds
// no row under RLS. The control is the same person with the right claim.
func TestBearerATenantClaimNamingAnotherTenantIsForbidden(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "bearer-home")
	tenantB, _ := plantTenant(t, ctx, admin, "bearer-elsewhere")
	subject := linkSubject(t, ctx, admin, plantUser(t, ctx, admin, tenantA, auth.RoleOrgAdmin))
	h, idp := bearerHandler(t, s)

	require.Equal(t, http.StatusOK, getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(subject, tenantA))).Code)
	rec := getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(subject, tenantB)))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, "forbidden", errorCode(t, rec))
}

func TestBearerATenantThatIsNotActiveIsRefused(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "bearer-state")
	subject := linkSubject(t, ctx, admin, plantUser(t, ctx, admin, tenantID, auth.RoleDriver))
	h, idp := bearerHandler(t, s)

	for _, state := range []string{"SUSPENDED", "CLOSED", "PROVISIONING", "ACTIVE"} {
		t.Run(state, func(t *testing.T) {
			_, err := admin.Exec(ctx, `UPDATE app.tenant SET state = $2::app.tenant_state WHERE id = $1`, tenantID, state)
			require.NoError(t, err)
			rec := getWithToken(t, h, "/api/me", idp.Mint(t, idp.Claims(subject, tenantID)))
			if state == "ACTIVE" {
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				return
			}
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			require.Equal(t, "tenant_inactive", errorCode(t, rec))
		})
	}
}

func TestBearerAMissingTenantClaimIsNotProvisioned(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h, idp := bearerHandler(t, s)
	claims := idp.Claims(uuid.New(), uuid.New())
	delete(claims, bearertest.TenantClaim)

	rec := getWithToken(t, h, "/api/me", idp.Mint(t, claims))
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "not_provisioned", errorCode(t, rec))
}

func TestBearerASessionStartIsRecordedOnce(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "bearer-session")
	subject := linkSubject(t, ctx, admin, plantUser(t, ctx, admin, tenantID, auth.RoleDriver))
	h, idp := bearerHandler(t, s)
	claims := idp.Claims(subject, tenantID)

	for i := 0; i < 2; i++ {
		require.Equal(t, http.StatusOK, getWithToken(t, h, "/api/me", idp.Mint(t, claims)).Code)
	}
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.audit_log WHERE tenant_id = $1 AND session_id = $2 AND action = 'SESSION_START'`,
		tenantID, "sid:"+claims["sid"].(string)).Scan(&n))
	require.Equal(t, 1, n)
}
