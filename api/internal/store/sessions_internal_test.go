package store

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSessionSetForgetsTheLeastRecentlyUsed(t *testing.T) {
	s := newSessionSet(2)
	s.add("a")
	s.add("b")
	require.True(t, s.has("a"), "has refreshes a, so b is now the oldest")
	s.add("c")
	require.True(t, s.has("a"))
	require.False(t, s.has("b"))
	require.True(t, s.has("c"))
}

func TestSessionSetAddingAKnownSessionDoesNotGrowIt(t *testing.T) {
	s := newSessionSet(2)
	s.add("a")
	s.add("a")
	s.add("b")
	require.True(t, s.has("a"))
	require.True(t, s.has("b"))
}
