package app

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

type imCallRequest struct {
	ConversationID int64
	CallerUsername string
	CalleeUsername string
	CallKind       string
	WSID           string
	PageID         string
}

func (a *App) getCallSession(callID string) *imCallSession {
	if a == nil {
		return nil
	}
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return nil
	}
	a.callSessionsMu.RLock()
	session := a.callSessions[callID]
	a.callSessionsMu.RUnlock()
	return session
}

func (a *App) deleteCallSession(callID string) {
	if a == nil {
		return
	}
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return
	}
	a.callSessionsMu.Lock()
	delete(a.callSessions, callID)
	a.callSessionsMu.Unlock()
}

func (a *App) createCallSession(ctx context.Context, req imCallRequest) (*imCallSession, error) {
	if a == nil {
		return nil, fmt.Errorf("app not ready")
	}
	if req.ConversationID <= 0 {
		return nil, fmt.Errorf("conversation_id required")
	}
	caller := strings.TrimSpace(req.CallerUsername)
	callee := strings.TrimSpace(req.CalleeUsername)
	if caller == "" || callee == "" {
		return nil, fmt.Errorf("caller or callee required")
	}
	kind := strings.TrimSpace(req.CallKind)
	if kind == "" {
		kind = "audio"
	}
	if !a.ensureConversationMember(ctx, fmt.Sprintf("%d", req.ConversationID), caller) {
		return nil, fmt.Errorf("caller not in conversation")
	}
	if !a.ensureConversationMember(ctx, fmt.Sprintf("%d", req.ConversationID), callee) {
		return nil, fmt.Errorf("callee not in conversation")
	}
	session := &imCallSession{
		CallID:         newCallID(),
		ConversationID: req.ConversationID,
		CallerUsername: caller,
		CalleeUsername: callee,
		CallKind:       kind,
		Status:         IMCallStatusDialing,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
		CallerWSID:     strings.TrimSpace(req.WSID),
		CallerPageID:   strings.TrimSpace(req.PageID),
	}
	a.callSessionsMu.Lock()
	if a.callSessions == nil {
		a.callSessions = map[string]*imCallSession{}
	}
	a.callSessions[session.CallID] = session
	a.callSessionsMu.Unlock()
	return session, nil
}

func (a *App) broadcastCallSessionEvent(session *imCallSession, eventType string, exclude *callHubConn, extra map[string]any) {
	if a == nil || session == nil || a.callHub == nil {
		return
	}
	if strings.TrimSpace(eventType) == "" {
		eventType = "im.call.updated"
	}
	payload := session.toMap()
	for k, v := range extra {
		payload[k] = v
	}
	message := map[string]any{
		"type":    eventType,
		"payload": payload,
	}
	roles := map[string]struct{}{}
	if strings.TrimSpace(session.CallerUsername) != "" {
		roles["caller"] = struct{}{}
	}
	if strings.TrimSpace(session.CalleeUsername) != "" {
		roles["callee"] = struct{}{}
	}
	a.callHub.publish(session.CallID, message, roles, exclude)
}

func (a *App) broadcastCallSession(session *imCallSession, exclude *callHubConn) {
	a.broadcastCallSessionEvent(session, "im.call.updated", exclude, nil)
}

func (a *App) pruneCallSessions() {
	if a == nil {
		return
	}
	a.callSessionsMu.Lock()
	for callID, session := range a.callSessions {
		if session == nil || !callSessionAlive(session) {
			delete(a.callSessions, callID)
		}
	}
	a.callSessionsMu.Unlock()
}

func (a *App) listActiveCallIDs() []string {
	if a == nil {
		return nil
	}
	a.callSessionsMu.RLock()
	ids := make([]string, 0, len(a.callSessions))
	for callID := range a.callSessions {
		ids = append(ids, callID)
	}
	a.callSessionsMu.RUnlock()
	sort.Strings(ids)
	return ids
}

func (a *App) maybePruneCalls() {
	a.pruneCallSessions()
}
