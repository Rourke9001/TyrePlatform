package httpapi

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	req "github.com/stretchr/testify/require" // aliased: see ratelimit_test.go
)

// schemaFunctionRef and schemaViewRef match an app.<name>( call or an
// app.v_<name> reference in this package's own SQL strings. Regexed against
// source at test time, not hand-listed: a call or a view name added,
// removed or renamed changes what discoverSchemaReferences returns with no
// edit to this file (TYRE-184 F6). Enum-cast type names (::app.unit_kind
// and its kind) are not covered by either pattern.
// TestEnumMirrorsMatchTheLiveSchema resolves app.unit_kind and app.user_role
// against the live schema; the other casts have no live check here.
var (
	schemaFunctionRef = regexp.MustCompile(`app\.([a-z][a-z0-9_]*)\(`)
	schemaViewRef     = regexp.MustCompile(`app\.(v_[a-z0-9_]+)`)
)

// discoverSchemaReferences reads every non-test .go file in this package and
// returns the function names and view names its SQL strings name. Excluding
// _test.go files makes this shorter than a whole-repo grep: a test fixture's
// setup query is covered transitively by the integration tests that run it,
// not by this catalogue.
func discoverSchemaReferences(t *testing.T) (functions map[string]bool, views map[string]bool) {
	t.Helper()
	functions = map[string]bool{}
	views = map[string]bool{}
	entries, err := os.ReadDir(".")
	req.NoError(t, err)
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		req.NoError(t, err)
		text := string(src)
		for _, m := range schemaFunctionRef.FindAllStringSubmatch(text, -1) {
			functions[m[1]] = true
		}
		for _, m := range schemaViewRef.FindAllStringSubmatch(text, -1) {
			views[m[1]] = true
		}
	}
	return functions, views
}

// TestSchemaFunctionsAndViewsExistLive is TestConflictCodesNameLiveSchemaObjects'
// sibling for the objects a constraint-name check does not reach: a function
// call or a view name that this package's SQL strings hardcode. A renamed
// function or view fails loudly only when a test happens to drive that
// route, and only at run time (docs/lessons.md, 2026-09-01, TYRE-95);
// conflictCodes' constraint check and TestEnumMirrorsMatchTheLiveSchema do
// not reach either kind of object, so this is what does. Rename a call this
// package makes and this goes red on the new name; the old one simply stops
// appearing in discoverSchemaReferences's result, so nothing pins it as
// missing, which is the correct behaviour for a name genuinely retired.
func TestSchemaFunctionsAndViewsExistLive(t *testing.T) {
	ctx := context.Background()
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL not set; this check needs a migrated Postgres")
	}
	conn, err := pgx.Connect(ctx, adminURL)
	req.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	functions, views := discoverSchemaReferences(t)

	for name := range functions {
		var exists bool
		req.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			                 WHERE n.nspname = 'app' AND p.proname = $1)`,
			name).Scan(&exists))
		req.True(t, exists, "this package calls app.%s(), which no live function carries", name)
	}

	for name := range views {
		var exists bool
		req.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			                 WHERE n.nspname = 'app' AND c.relname = $1 AND c.relkind = 'v')`,
			name).Scan(&exists))
		req.True(t, exists, "this package names app.%s, which no live view carries", name)
	}
}
