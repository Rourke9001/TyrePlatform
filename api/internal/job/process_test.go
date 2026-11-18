package job

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRunDailyWithoutDatabaseURLExitsOne(t *testing.T) {
	var out bytes.Buffer
	require.Equal(t, 1, RunDaily(context.Background(), func(string) string { return "" }, &out))
	got := lines(t, &out)
	f := withEvent(got, EventFailed)
	require.Len(t, f, 1)
	require.Equal(t, "config", f[0]["stage"])
	require.Equal(t, "daily", f[0]["job"])
	require.Empty(t, withEvent(got, EventSucceeded))
}

// The pool is set in code, so a DSN in the vault that names its own size
// cannot raise it past ADR-0005's arithmetic.
func TestOpenStoreCapsThePoolAtTwo(t *testing.T) {
	dsn := os.Getenv("TEST_JOB_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_JOB_DATABASE_URL not set")
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	s, err := openStore(context.Background(), dsn+sep+"pool_max_conns=7")
	require.NoError(t, err)
	t.Cleanup(s.Close)
	require.EqualValues(t, 2, s.MaxConns())
}
