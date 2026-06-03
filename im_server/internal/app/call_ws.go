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
}

func (a *App) handleCallSignal(username string, client *HubConn, env wsEnvelope, r *http.Request) bool {
	_ = r
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
		session.Status = IMCallStatusRinging
		session.RingingAt = time.Now()
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.started", nil, nil)
		a.broadcastCallSessionEvent(session, "im.call.ringing", nil, nil)
		return true
	case "im.call.accept":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			sendError("call not found")
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
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.accepted", nil, nil)
		a.broadcastCallSessionEvent(session, "im.call.connected", nil, nil)
		return true
	case "im.call.reject":
		session := a.getCallSession(payload.CallID)
		if session == nil {
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
		if strings.EqualFold(username, session.CallerUsername) {
			session.CallerMuted = payload.Muted
		} else if strings.EqualFold(username, session.CalleeUsername) {
			session.CalleeMuted = payload.Muted
		}
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.updated", nil, nil)
		return true
	}
	return false
}
