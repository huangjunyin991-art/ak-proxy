package app

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

func newCallID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return "call_" + hex.EncodeToString(buf)
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
