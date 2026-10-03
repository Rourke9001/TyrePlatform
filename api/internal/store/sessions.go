package store

import (
	"container/list"
	"sync"
)

// sessionLimit bounds the sessions one replica remembers (spec section 3). A
// forgotten session costs one more call, which the unique index absorbs.
const sessionLimit = 10_000

// sessionSet remembers the sessions this replica has recorded, so a session
// start costs one write per session rather than one per request (FR-AUD-004).
type sessionSet struct {
	mu    sync.Mutex
	limit int
	order *list.List // front is the most recently used
	byKey map[string]*list.Element
}

func newSessionSet(limit int) *sessionSet {
	return &sessionSet{limit: limit, order: list.New(), byKey: make(map[string]*list.Element)}
}

func (s *sessionSet) has(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.byKey[key]
	if ok {
		s.order.MoveToFront(e)
	}
	return ok
}

func (s *sessionSet) add(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.byKey[key]; ok {
		s.order.MoveToFront(e)
		return
	}
	s.byKey[key] = s.order.PushFront(key)
	if s.order.Len() > s.limit {
		oldest := s.order.Back()
		s.order.Remove(oldest)
		delete(s.byKey, oldest.Value.(string))
	}
}
