package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type callSignalEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type callSignalPayload struct {
	CallID         string `json:"call_id,omitempty"`
	ConversationID int64  `json:"conversation_id,omitempty"`
	CallerUsername string `json:"caller_username,omitempty"`
	CalleeUsername string `json:"callee_username,omitempty"`
	Role           string `json:"role,omitempty"`
	WSID           string `json:"ws_id,omitempty"`
	PageID         string `json:"page_id,omitempty"`
	CallKind       string `json:"call_kind,omitempty"`
	Muted          bool   `json:"muted,omitempty"`
	SDP            any    `json:"sdp,omitempty"`
	Candidate      any    `json:"candidate,omitempty"`
}

func (a *App) handleCallSignal(username string, client *HubConn, env wsEnvelope, r *http.Request) bool {
	var payload callSignalPayload
	if len(env.Payload) > 0 {
		_ = json.Unmarshal(env.Payload, &payload)
	}
	sendError := func(message string) {
		_ = client.WriteJSON(map[string]any{"type": "im.call.error", "payload": map[string]any{"message": message}})
	}
	switch env.Type {
	case "im.call.start":
		session, err := a.createCallSession(r.Context(), imCallRequest{
			ConversationID: payload.ConversationID,
			CallerUsername: username,
			CalleeUsername: payload.CalleeUsername,
			CallKind:       payload.CallKind,
			WSID:           payload.WSID,
			PageID:         payload.PageID,
		})
		if err != nil {
			sendError(err.Error())
			return true
		}
		a.sendCallEventToUsername(session.CallerUsername, "im.call.started", session.toMap())
		a.sendCallEventToUsername(session.CalleeUsername, "im.call.ringing", session.toMap())
		return true
	case "im.call.accept":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			sendError("call not found")
			return true
		}
		if a.callUserRole(session, username) != "callee" {
			sendError("forbidden")
			return true
		}
		session.Status = IMCallStatusActive
		now := time.Now()
		if session.AcceptedAt.IsZero() {
			session.AcceptedAt = now
		}
		if session.ConnectedAt.IsZero() {
			session.ConnectedAt = now
		}
		session.CalleeWSID = strings.TrimSpace(payload.WSID)
		session.CalleePageID = strings.TrimSpace(payload.PageID)
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.accepted", nil, nil)
		a.broadcastCallSessionEvent(session, "im.call.connected", nil, nil)
		return true
	case "im.call.reject":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			return true
		}
		if a.callUserRole(session, username) == "" {
			sendError("forbidden")
			return true
		}
		session.Status = IMCallStatusFailed
		session.EndedAt = time.Now()
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.failed", nil, nil)
		a.deleteCallSession(session.CallID)
		return true
	case "im.call.hangup":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			return true
		}
		if a.callUserRole(session, username) == "" {
			sendError("forbidden")
			return true
		}
		session.Status = IMCallStatusEnded
		session.EndedAt = time.Now()
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.ended", nil, nil)
		a.deleteCallSession(session.CallID)
		return true
	case "im.call.mute":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			return true
		}
		role := a.callUserRole(session, username)
		if role == "" {
			sendError("forbidden")
			return true
		}
		if strings.EqualFold(username, session.CallerUsername) {
			session.CallerMuted = payload.Muted
		} else if strings.EqualFold(username, session.CalleeUsername) {
			session.CalleeMuted = payload.Muted
		}
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.updated", nil, map[string]any{"muted_by": role})
		return true
	case "im.call.offer", "im.call.answer", "im.call.ice":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			sendError("call not found")
			return true
		}
		role := a.callUserRole(session, username)
		if role == "" {
			sendError("forbidden")
			return true
		}
		peerUsername := callPeerUsername(session, username)
		if peerUsername == "" {
			sendError("peer not found")
			return true
		}
		forward := map[string]any{
			"call_id":          session.CallID,
			"conversation_id":  session.ConversationID,
			"caller_username":  session.CallerUsername,
			"callee_username":  session.CalleeUsername,
			"call_kind":        session.CallKind,
			"from_username":    normalizeCallUsername(username),
			"from_role":        role,
			"to_username":      peerUsername,
			"status":           string(session.Status),
		}
		if payload.SDP != nil {
			forward["sdp"] = payload.SDP
		}
		if payload.Candidate != nil {
			forward["candidate"] = payload.Candidate
		}
		a.sendCallEventToUsername(peerUsername, env.Type, forward)
		return true
	}
	return false
}
