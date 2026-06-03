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

func normalizeCallID(value string) string {
	return strings.TrimSpace(value)
}

func normalizeCallUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
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
	session := a.callSessions[normalizeCallID(callID)]
	a.callSessionsMu.RUnlock()
	return session
}

func (a *App) deleteCallSession(callID string) {
	if a == nil {
		return
	}
	a.callSessionsMu.Lock()
	delete(a.callSessions, normalizeCallID(callID))
	a.callSessionsMu.Unlock()
}

func (a *App) broadcastCallSessionEvent(session *imCallSession, eventType string, exclude *callHubConn, extra map[string]any) {
	if a == nil || session == nil {
		return
	}
	_ = exclude
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
	a.broadcastUsernames(callParticipantSet(session), message)
}

func (a *App) broadcastCallSession(session *imCallSession, includeRoles map[string]struct{}) {
	if a == nil || session == nil {
		return
	}
	_ = includeRoles
	payload := map[string]any{
		"type": "im.call.session_state",
		"payload": session.toMap(),
	}
	a.broadcastUsernames(callParticipantSet(session), payload)
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
	a.maybePruneCalls()
	conversationID := req.ConversationID
	if conversationID <= 0 {
		return nil, errors.New("invalid conversation_id")
	}
	caller := normalizeCallUsername(req.CallerUsername)
	callee := normalizeCallUsername(req.CalleeUsername)
	if caller == "" || callee == "" {
		return nil, errors.New("missing caller_username or callee_username")
	}
	if caller == callee {
		return nil, errors.New("cannot call self")
	}
	if !a.ensureConversationMember(ctx, fmt.Sprint(conversationID), caller) {
		return nil, errors.New("forbidden")
	}
	if !a.ensureConversationMember(ctx, fmt.Sprint(conversationID), callee) {
		return nil, errors.New("callee not in conversation")
	}
	meta, err := a.loadConversationMeta(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	if meta.ConversationType != "direct" {
		return nil, errors.New("call only supports direct conversations")
	}
	if existing := a.findActiveCallByConversation(conversationID); existing != nil {
		return nil, errors.New("busy")
	}
	if existing := a.findActiveCallByUser(caller, callee); existing != nil {
		return nil, errors.New("busy")
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
		CallerWSID:     strings.TrimSpace(req.WSID),
		CallerPageID:   strings.TrimSpace(req.PageID),
	}
	a.upsertCallSession(session)
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
		if callSessionAlive(session) {
			return session
		}
	}
	return nil
}

func (a *App) findActiveCallByUser(usernames ...string) *imCallSession {
	if a == nil || len(usernames) == 0 {
		return nil
	}
	userSet := map[string]struct{}{}
	for _, username := range usernames {
		normalizedUsername := normalizeCallUsername(username)
		if normalizedUsername != "" {
			userSet[normalizedUsername] = struct{}{}
		}
	}
	if len(userSet) == 0 {
		return nil
	}
	a.callSessionsMu.RLock()
	defer a.callSessionsMu.RUnlock()
	for _, session := range a.callSessions {
		if session == nil || !callSessionAlive(session) {
			continue
		}
		if _, ok := userSet[normalizeCallUsername(session.CallerUsername)]; ok {
			return session
		}
		if _, ok := userSet[normalizeCallUsername(session.CalleeUsername)]; ok {
			return session
		}
	}
	return nil
}

func callParticipantSet(session *imCallSession) map[string]struct{} {
	result := map[string]struct{}{}
	if session == nil {
		return result
	}
	if caller := normalizeCallUsername(session.CallerUsername); caller != "" {
		result[caller] = struct{}{}
	}
	if callee := normalizeCallUsername(session.CalleeUsername); callee != "" {
		result[callee] = struct{}{}
	}
	return result
}

func (a *App) callUserRole(session *imCallSession, username string) string {
	normalizedUsername := normalizeCallUsername(username)
	if session == nil || normalizedUsername == "" {
		return ""
	}
	if strings.EqualFold(session.CallerUsername, normalizedUsername) {
		return "caller"
	}
	if strings.EqualFold(session.CalleeUsername, normalizedUsername) {
		return "callee"
	}
	return ""
}

func callPeerUsername(session *imCallSession, username string) string {
	normalizedUsername := normalizeCallUsername(username)
	if session == nil || normalizedUsername == "" {
		return ""
	}
	if strings.EqualFold(session.CallerUsername, normalizedUsername) {
		return normalizeCallUsername(session.CalleeUsername)
	}
	if strings.EqualFold(session.CalleeUsername, normalizedUsername) {
		return normalizeCallUsername(session.CallerUsername)
	}
	return ""
}

func (a *App) sendCallEventToUsername(username string, eventType string, payload map[string]any) {
	normalizedUsername := normalizeCallUsername(username)
	if a == nil || normalizedUsername == "" {
		return
	}
	if strings.TrimSpace(eventType) == "" {
		eventType = "im.call.updated"
	}
	a.hub.send(normalizedUsername, map[string]any{
		"type":    eventType,
		"payload": payload,
	})
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
	role := a.callUserRole(session, username)
	if role == "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	switch action {
	case "accept":
		if role != "callee" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
			return
		}
		session.Status = IMCallStatusActive
		now := time.Now()
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
		if role == "caller" {
			session.CallerMuted = req.Muted
		} else {
			session.CalleeMuted = req.Muted
		}
	case "unmute":
		if role == "caller" {
			session.CallerMuted = req.Muted
		} else {
			session.CalleeMuted = req.Muted
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "unsupported action"})
		return
	}
	session.touch()
	switch action {
	case "accept":
		a.broadcastCallSessionEvent(session, "im.call.accepted", nil, nil)
		a.broadcastCallSessionEvent(session, "im.call.connected", nil, nil)
	case "reject":
		a.broadcastCallSessionEvent(session, "im.call.failed", nil, nil)
		defer a.deleteCallSession(session.CallID)
	case "hangup":
		a.broadcastCallSessionEvent(session, "im.call.ended", nil, nil)
		defer a.deleteCallSession(session.CallID)
	case "mute", "unmute":
		a.broadcastCallSessionEvent(session, "im.call.updated", nil, map[string]any{"muted_by": role})
	}
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
