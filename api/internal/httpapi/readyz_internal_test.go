package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	// Aliased: this file shares package httpapi with httpapi.go's own
	// capability-check function named require (ratelimit_test.go).
	req "github.com/stretchr/testify/require"
)

// testClock is the probe's clock, moved only by the test, so nothing here
// sleeps to cross readyFor.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

// countingPinger blocks every ping until release closes, so a test can hold
// one flight open while others join it. result says what call n returns.
type countingPinger struct {
	calls   atomic.Int32
	entered chan struct{}
	once    sync.Once
	release chan struct{}
	result  func(n int32) error

	mu      sync.Mutex
	lastCtx context.Context
}

func newCountingPinger(result func(n int32) error) *countingPinger {
	return &countingPinger{entered: make(chan struct{}), release: make(chan struct{}), result: result}
}

func (p *countingPinger) Ping(ctx context.Context) error {
	n := p.calls.Add(1)
	p.mu.Lock()
	p.lastCtx = ctx
	p.mu.Unlock()
	p.once.Do(func() { close(p.entered) })
	<-p.release
	return p.result(n)
}

func (p *countingPinger) captured() context.Context {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastCtx
}

func alwaysReady(int32) error { return nil }

var errDatabaseGone = errors.New("database gone")

func serveReadyz(ctx context.Context, h http.Handler) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/readyz", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// waitFor fails the test rather than hanging it when a signal never comes.
func waitFor(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// concurrentReadyz starts n requests against one probe, holds its ping open
// until n-1 of them have provably joined the flight, and returns every
// response once release closes. Without the join count a plain cache, with
// no single flight, would pass: each request could ping in turn.
func concurrentReadyz(t *testing.T, p *countingPinger, n int) []*httptest.ResponseRecorder {
	t.Helper()
	clock := &testClock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	probe := newReadinessProbe(p, clock.Now)
	joined := make(chan struct{}, n)
	probe.onJoin = func() { joined <- struct{}{} }
	h := readyz(probe, "abc1234", "")

	recs := make([]*httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			recs[i] = serveReadyz(context.Background(), h)
		}()
	}
	waitFor(t, p.entered, "the first ping")
	for range n - 1 {
		waitFor(t, joined, "a request to join the flight")
	}
	req.EqualValues(t, 1, p.calls.Load(), "requests that found a ping in flight must wait for it, not start their own")
	close(p.release)
	wg.Wait()
	return recs
}

func TestReadyzOnePingForConcurrentRequests(t *testing.T) {
	p := newCountingPinger(alwaysReady)
	for _, rec := range concurrentReadyz(t, p, 20) {
		req.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	req.EqualValues(t, 1, p.calls.Load())
}

func TestReadyzPingsAgainAfterTheBound(t *testing.T) {
	p := newCountingPinger(alwaysReady)
	close(p.release)
	t0 := time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)
	clock := &testClock{t: t0}
	h := readyz(newReadinessProbe(p, clock.Now), "abc1234", "")

	req.Equal(t, http.StatusOK, serveReadyz(context.Background(), h).Code)
	req.EqualValues(t, 1, p.calls.Load())

	clock.Set(t0.Add(readyFor - time.Millisecond))
	req.Equal(t, http.StatusOK, serveReadyz(context.Background(), h).Code)
	req.EqualValues(t, 1, p.calls.Load(), "a result younger than readyFor stands")

	clock.Set(t0.Add(readyFor))
	req.Equal(t, http.StatusOK, serveReadyz(context.Background(), h).Code)
	req.EqualValues(t, 2, p.calls.Load(), "a result readyFor old is stale")
}

func TestReadyzFailureReachesEveryWaiter(t *testing.T) {
	p := newCountingPinger(func(int32) error { return errDatabaseGone })
	for _, rec := range concurrentReadyz(t, p, 20) {
		req.Equal(t, http.StatusServiceUnavailable, rec.Code)
		req.JSONEq(t, `{"status":"unready","sha":"abc1234","revision":""}`, rec.Body.String())
	}
	req.EqualValues(t, 1, p.calls.Load())
}

func TestReadyzRecoveryShowsWithinTheBound(t *testing.T) {
	p := newCountingPinger(func(n int32) error {
		if n == 1 {
			return errDatabaseGone
		}
		return nil
	})
	close(p.release)
	t0 := time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)
	clock := &testClock{t: t0}
	h := readyz(newReadinessProbe(p, clock.Now), "abc1234", "")

	req.Equal(t, http.StatusServiceUnavailable, serveReadyz(context.Background(), h).Code)
	clock.Set(t0.Add(readyFor))
	req.Equal(t, http.StatusOK, serveReadyz(context.Background(), h).Code, "a failure is cached for the same bound as a success, no longer")
}

func TestReadyzPingOutlivesTheFirstCaller(t *testing.T) {
	p := newCountingPinger(alwaysReady)
	clock := &testClock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	h := readyz(newReadinessProbe(p, clock.Now), "abc1234", "")

	ctxA, cancelA := context.WithCancel(context.Background())
	answerA := make(chan int, 1)
	go func() { answerA <- serveReadyz(ctxA, h).Code }()
	waitFor(t, p.entered, "the first ping")
	cancelA()
	select {
	case code := <-answerA:
		req.Equal(t, http.StatusServiceUnavailable, code, "a caller whose context ends answers unready")
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled caller kept waiting on the ping")
	}

	pingCtx := p.captured()
	req.NoError(t, pingCtx.Err(), "the first caller's cancellation must not reach the shared ping")
	deadline, ok := pingCtx.Deadline()
	req.True(t, ok, "the shared ping keeps its own budget")
	req.LessOrEqual(t, time.Until(deadline), readyTimeout)

	close(p.release)
	req.Equal(t, http.StatusOK, serveReadyz(context.Background(), h).Code)
	req.EqualValues(t, 1, p.calls.Load())
}
