package httpapi

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	// Aliased: this file shares package httpapi with httpapi.go's own
	// capability-check function named require, so the unaliased import would
	// shadow it (refusal_internal_test.go's own convention).
	req "github.com/stretchr/testify/require"
)

// unitKinds and tenantRoles mirror Postgres enums so a bad value is a 422
// naming the field rather than a canned 500 (ADR-0013). A mirror the enum
// has outgrown refuses a value the database would accept; one that has
// outgrown the enum lets a value through to a cast error. Both are silent
// without this, the same way a renamed constraint was before
// TestConflictCodesNameLiveSchemaObjects.
func TestEnumMirrorsMatchTheLiveSchema(t *testing.T) {
	ctx := context.Background()
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL not set; this check needs a migrated Postgres")
	}
	conn, err := pgx.Connect(ctx, adminURL)
	req.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	cases := []struct {
		name   string
		enum   string
		mirror map[string]bool
		// Values the enum carries that the mirror must not: a tenant may
		// never create a PLATFORM_ADMIN (ADR-0013).
		omitted []string
	}{
		{"unitKinds", "app.unit_kind", unitKinds, nil},
		{"tenantRoles", "app.user_role", tenantRoles, []string{"PLATFORM_ADMIN"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rows, err := conn.Query(ctx, `SELECT unnest(enum_range(NULL::`+c.enum+`))::text`)
			req.NoError(t, err)
			want := map[string]bool{}
			for rows.Next() {
				var v string
				req.NoError(t, rows.Scan(&v))
				want[v] = true
			}
			req.NoError(t, rows.Err())
			for _, v := range c.omitted {
				req.True(t, want[v], "%s no longer carries %q; drop it from omitted", c.enum, v)
				delete(want, v)
			}
			req.Equal(t, want, c.mirror, "%s must equal %s minus %v", c.name, c.enum, c.omitted)
		})
	}
}
