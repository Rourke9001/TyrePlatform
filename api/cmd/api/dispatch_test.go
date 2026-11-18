package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestMainHelper is main itself when the tests below start this binary as a
// child, so they read main's real exit code and output. Run directly, it
// does nothing.
func TestMainHelper(t *testing.T) {
	if os.Getenv("API_MAIN_HELPER") != "1" {
		return
	}
	for i, a := range os.Args {
		if a == "--" {
			os.Args = append([]string{"api"}, os.Args[i+1:]...)
			break
		}
	}
	main()
	os.Exit(0)
}

// runMain starts main in a child with only the given environment, killed
// after 30 s so a dispatch that starts a server fails instead of hanging.
func runMain(t *testing.T, env []string, args ...string) *exec.Cmd {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestMainHelper$", "--"}, args...)...)
	cmd.Env = append([]string{"API_MAIN_HELPER=1"}, env...)
	return cmd
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	_, port, err := net.SplitHostPort(l.Addr().String())
	require.NoError(t, err)
	require.NoError(t, l.Close())
	return port
}

// A typing mistake in a template must never start a server inside a job
// (spec section 2).
func TestMainRefusesAnythingButJobDaily(t *testing.T) {
	for _, args := range [][]string{{"bogus"}, {"job"}, {"job", "weekly"}, {"job", "daily", "extra"}, {"Job", "daily"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel() // each on its own port, so the red run waits one 30 s kill, not five
			var stdout, stderr bytes.Buffer
			cmd := runMain(t, []string{"PORT=" + freePort(t), "DATABASE_URL=" + os.Getenv("TEST_DATABASE_URL")}, args...)
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			var exit *exec.ExitError
			require.ErrorAs(t, cmd.Run(), &exit)
			require.Equal(t, 2, exit.ExitCode())
			require.Equal(t, "usage: api [job daily]\n", stderr.String())
			require.NotContains(t, stdout.String(), "listening")
		})
	}
}

func TestMainJobDailyNeedsItsDatabaseURL(t *testing.T) {
	var stdout, stderr bytes.Buffer
	cmd := runMain(t, nil, "job", "daily")
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	var exit *exec.ExitError
	require.ErrorAs(t, cmd.Run(), &exit)
	require.Equal(t, 1, exit.ExitCode())
	require.Contains(t, stdout.String(), `"event":"daily_job_failed"`)
	require.Contains(t, stdout.String(), `"stage":"config"`)
	require.NotContains(t, stdout.String(), "listening")
}

func TestMainWithNoArgumentsServes(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	port := freePort(t)
	cmd := runMain(t, []string{"PORT=" + port, "DATABASE_URL=" + dsn})
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	require.Eventually(t, func() bool {
		res, err := http.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	}, 20*time.Second, 100*time.Millisecond)
}
