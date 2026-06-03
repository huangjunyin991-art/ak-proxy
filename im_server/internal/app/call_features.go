package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

type imCallRequest struct {
	ConversationID int64  `json:"conversation_id"`
	CallerUsername string `json:"caller_username"`
	CalleeUsername string `json:"callee_username"`
	CallKind       string `json:"call_kind"`
	WSID           string `json:"ws_id,omitempty"`
	PageID         string `json:"page_id,omitempty"`
}

type imCallActionRequest struct {
	CallID string `json:"call_id"`
	Role   string `json:"role,omitempty"`
	Muted  bool   `json:"muted,omitempty"`
}

func (a *App) upsertCallSession(session *imCallSession) {
	if a == nil || session == nil {
		return
	}
	a.callSessionsMu.Lock()
	a.callSessions[session.CallID] = session
	a.callSessionsMu.Unlock()
}

func (a *App) getCallSession(callID string) *imCallSession {
	if a == nil {
		return nil
	}
	a.callSessionsMu.RLock()
	session := a.callSessions[strings.TrimSpace(callID)]
	a.callSessionsMu.RUnlock()
	return session
}

func (a *App) deleteCallSession(callID string) {
	if a == nil {
		return
	}
	a.callSessionsMu.Lock()
	delete(a.callSessions, strings.TrimSpace(callID))
	a.callSessionsMu.Unlock()
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

func (a *App) broadcastCallSession(session *imCallSession, includeRoles map[string]struct{}) {
	if a == nil || session == nil || a.callHub == nil {
		return
	}
	payload := map[string]any{
		"type": "im.call.session_state",
		"payload": session.toMap(),
	}
	a.callHub.publish(session.CallID, payload, includeRoles, nil)
}

func (a *App) loadCallSessionState(callID string) map[string]any {
	session := a.getCallSession(callID)
	if session == nil {
		return map[string]any{"found": false}
	}
	return map[string]any{"found": true, "session": session.toMap()}
}

func (a *App) createCallSession(ctx context.Context, req imCallRequest) (*imCallSession, error) {
	if a == nil {
		return nil, errors.New("app unavailable")
	}
	conversationID := req.ConversationID
	if conversationID <= 0 {
		return nil, errors.New("invalid conversation_id")
	}
	caller := strings.ToLower(strings.TrimSpace(req.CallerUsername))
	callee := strings.ToLower(strings.TrimSpace(req.CalleeUsername))
	if caller == "" || callee == "" {
		return nil, errors.New("missing caller_username or callee_username")
	}
	if caller == callee {
		return nil, errors.New("cannot call self")
	}
	if !a.ensureConversationMember(ctx, fmt.Sprint(conversationID), caller) {
		return nil, errors.New("forbidden")
	}
	existing := a.findActiveCallByConversation(conversationID)
	if existing != nil {
		existing.Status = IMCallStatusBusy
		existing.touch()
		a.broadcastCallSession(existing, nil)
		return existing, nil
	}
	session := &imCallSession{
		CallID:         newCallID(),
		ConversationID: conversationID,
		CallerUsername: caller,
		CalleeUsername: callee,
		CallKind:       normalizeCallKind(req.CallKind),
		Status:         IMCallStatusRinging,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
		RingingAt:      time.Now(),
	}
	a.upsertCallSession(session)
	a.broadcastCallSession(session, map[string]struct{}{caller: {}, callee: {}})
	return session, nil
}

func normalizeCallKind(value string) string {
	kind := strings.ToLower(strings.TrimSpace(value))
	if kind == "video" {
		return "video"
	}
	return "audio"
}

func (a *App) findActiveCallByConversation(conversationID int64) *imCallSession {
	if a == nil || conversationID <= 0 {
		return nil
	}
	a.callSessionsMu.RLock()
	defer a.callSessionsMu.RUnlock()
	for _, session := range a.callSessions {
		if session == nil || session.ConversationID != conversationID {
			continue
		}
		if session.Status == IMCallStatusRinging || session.Status == IMCallStatusDialing || session.Status == IMCallStatusActive {
			return session
		}
	}
	return nil
}

func (a *App) handleCallStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req imCallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	req.CallerUsername = username
	session, err := a.createCallSession(r.Context(), req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "session": session.toMap()})
}

func (a *App) handleCallState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	callID := strings.TrimSpace(r.URL.Query().Get("call_id"))
	writeJSON(w, http.StatusOK, a.loadCallSessionState(callID))
}

func (a *App) handleCallAction(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req imCallActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	session := a.getCallSession(req.CallID)
	if session == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "call not found"})
		return
	}
	role := strings.ToLower(strings.TrimSpace(req.Role))
	if role == "" {
		if strings.EqualFold(session.CallerUsername, username) {
			role = "caller"
		} else if strings.EqualFold(session.CalleeUsername, username) {
			role = "callee"
		}
	}
	if role == "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	switch action {
	case "accept":
		session.Status = IMCallStatusActive
		now := time.Now()
		session.AcceptedAt = session.AcceptedAt
		if session.AcceptedAt.IsZero() {
			session.AcceptedAt = now
		}
		if session.ConnectedAt.IsZero() {
			session.ConnectedAt = now
		}
	case "reject":
		session.Status = IMCallStatusFailed
		session.EndedAt = time.Now()
	case "hangup":
		session.Status = IMCallStatusEnded
		session.EndedAt = time.Now()
	case "mute":
		session.CallerMuted = req.Muted
	case "unmute":
		session.CalleeMuted = req.Muted
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "unsupported action"})
		return
	}
	session.touch()
	if session.Status == IMCallStatusEnded || session.Status == IMCallStatusFailed || session.Status == IMCallStatusBusy || session.Status == IMCallStatusTimeout {
		defer a.deleteCallSession(session.CallID)
	}
	a.broadcastCallSession(session, map[string]struct{}{session.CallerUsername: {}, session.CalleeUsername: {}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "session": session.toMap()})
}

func (a *App) handleCallHub(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	callID := strings.TrimSpace(r.URL.Query().Get("call_id"))
	role := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("role")))
	if callID == "" || role == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing call_id or role"})
		return
	}
	session := a.getCallSession(callID)
	if session == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "call not found"})
		return
	}
	if !strings.EqualFold(session.CallerUsername, username) && !strings.EqualFold(session.CalleeUsername, username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	conn := a.callHub.connect(callID, role, r.URL.Query().Get("ws_id"), r.URL.Query().Get("page_id"))
	defer a.callHub.disconnect(callID, conn)
	_ = conn
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleCallRoutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Path)
	switch {
	case strings.HasSuffix(path, "/call/start"):
		a.handleCallStart(w, r)
	case strings.HasSuffix(path, "/call/state"):
		a.handleCallState(w, r)
	case strings.HasSuffix(path, "/call/accept"):
		a.handleCallAction(w, r, "accept")
	case strings.HasSuffix(path, "/call/reject"):
		a.handleCallAction(w, r, "reject")
	case strings.HasSuffix(path, "/call/hangup"):
		a.handleCallAction(w, r, "hangup")
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "not found"})
	}
}

func (a *App) maybePruneCalls() {
	if a == nil {
		return
	}
	a.callSessionsMu.Lock()
	for callID, session := range a.callSessions {
		if session == nil {
			delete(a.callSessions, callID)
			continue
		}
		if !callSessionAlive(session) {
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
	defer a.callSessionsMu.RUnlock()
	ids := make([]string, 0, len(a.callSessions))
	for callID := range a.callSessions {
		ids = append(ids, callID)
	}
	sort.Strings(ids)
	return ids
}
