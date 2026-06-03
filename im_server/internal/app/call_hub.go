package app

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
	"time"
)

type callHub struct {
	mu    sync.RWMutex
	conns map[string]map[*callHubConn]struct{}
}

type callHubConn struct {
	role      string
	wsID      string
	pageID    string
	outbound  chan map[string]any
	done      chan struct{}
	closeOnce sync.Once
}

func newCallHub() *callHub {
	return &callHub{conns: map[string]map[*callHubConn]struct{}{}}
}

func (h *callHub) connect(callID string, role string, wsID string, pageID string) *callHubConn {
	conn := &callHubConn{
		role:     strings.ToLower(strings.TrimSpace(role)),
		wsID:     strings.TrimSpace(wsID),
		pageID:   strings.TrimSpace(pageID),
		outbound: make(chan map[string]any, 32),
		done:     make(chan struct{}),
	}
	h.mu.Lock()
	if _, ok := h.conns[callID]; !ok {
		h.conns[callID] = map[*callHubConn]struct{}{}
	}
	h.conns[callID][conn] = struct{}{}
	h.mu.Unlock()
	return conn
}

func (h *callHub) disconnect(callID string, conn *callHubConn) {
	if h == nil || conn == nil {
		return
	}
	h.mu.Lock()
	bucket, ok := h.conns[callID]
	if ok {
		delete(bucket, conn)
		if len(bucket) == 0 {
			delete(h.conns, callID)
		}
	}
	h.mu.Unlock()
	conn.close()
}

func (h *callHub) publish(callID string, payload map[string]any, includeRoles map[string]struct{}, exclude *callHubConn) {
	if h == nil {
		return
	}
	h.mu.RLock()
	bucket := make([]*callHubConn, 0)
	for conn := range h.conns[callID] {
		bucket = append(bucket, conn)
	}
	h.mu.RUnlock()
	for _, conn := range bucket {
		if conn == nil {
			continue
		}
		if exclude != nil && conn == exclude {
			continue
		}
		if len(includeRoles) > 0 {
			if _, ok := includeRoles[conn.role]; !ok {
				continue
			}
		}
		select {
		case conn.outbound <- payload:
		default:
		}
	}
}

func (c *callHubConn) close() {
	if c == nil {
		return
	}
	c.closeOnce.Do(func() {
		close(c.done)
	})
}

func newCallID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return "call_" + hex.EncodeToString(buf)
}

func sortedCallRoles(connMap map[*callHubConn]struct{}) []string {
	roles := make([]string, 0, len(connMap))
	seen := map[string]struct{}{}
	for conn := range connMap {
		if conn == nil {
			continue
		}
		if conn.role == "" {
			continue
		}
		if _, ok := seen[conn.role]; ok {
			continue
		}
		seen[conn.role] = struct{}{}
		roles = append(roles, conn.role)
	}
	sort.Strings(roles)
	return roles
}

func callSessionAlive(session *imCallSession) bool {
	if session == nil {
		return false
	}
	now := time.Now()
	if session.Status == IMCallStatusDialing || session.Status == IMCallStatusRinging {
		return now.Sub(session.CreatedAt) < imCallTimeoutSeconds*time.Second
	}
	if session.Status == IMCallStatusActive {
		start := session.ConnectedAt
		if start.IsZero() {
			start = session.AcceptedAt
		}
		if start.IsZero() {
			start = session.CreatedAt
		}
		return now.Sub(start) < imCallActiveTimeoutSeconds*time.Second
	}
	return false
}
