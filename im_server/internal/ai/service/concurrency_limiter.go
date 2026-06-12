package service

import "sync"

type AdjustableLimiter struct {
	mu       sync.Mutex
	cond     *sync.Cond
	limit    int
	inFlight int
	waiting  int
}

func NewAdjustableLimiter(limit int) *AdjustableLimiter {
	item := &AdjustableLimiter{limit: normalizeQueueConcurrency(limit)}
	item.cond = sync.NewCond(&item.mu)
	return item
}

func (l *AdjustableLimiter) Acquire() func() {
	if l == nil {
		return func() {}
	}
	l.mu.Lock()
	for l.inFlight >= l.limit {
		l.waiting++
		l.cond.Wait()
		l.waiting--
	}
	l.inFlight++
	l.mu.Unlock()
	return l.Release
}

func (l *AdjustableLimiter) Release() {
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.inFlight > 0 {
		l.inFlight--
	}
	l.cond.Broadcast()
	l.mu.Unlock()
}

func (l *AdjustableLimiter) SetLimit(limit int) int {
	if l == nil {
		return 0
	}
	normalized := normalizeQueueConcurrency(limit)
	l.mu.Lock()
	l.limit = normalized
	l.cond.Broadcast()
	l.mu.Unlock()
	return normalized
}

func (l *AdjustableLimiter) Stats() (limit int, inFlight int, waiting int) {
	if l == nil {
		return 0, 0, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.limit, l.inFlight, l.waiting
}
