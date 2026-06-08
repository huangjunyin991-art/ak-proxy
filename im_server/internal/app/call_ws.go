package app

import (
	"encoding/json"
	"log"
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
	sendError := func(reason string, message string) {
		errorPayload := map[string]any{
			"message": message,
		}
		if strings.TrimSpace(reason) != "" {
			errorPayload["reason"] = strings.TrimSpace(reason)
		}
		_ = client.WriteJSON(map[string]any{"type": "im.call.error", "payload": errorPayload})
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
			reason := "call_start_failed"
			switch strings.ToLower(strings.TrimSpace(err.Error())) {
			case "busy":
				reason = "busy"
			case "forbidden":
				reason = "forbidden"
			case "callee not in conversation":
				reason = "peer_not_found"
			case "cannot call self":
				reason = "invalid_target"
			case "call only supports direct conversations":
				reason = "unsupported"
			}
			sendError(reason, err.Error())
			return true
		}
		a.sendCallEventToUsername(session.CallerUsername, "im.call.started", a.buildCallEventPayload(session, session.CallerUsername, map[string]any{
			"reason": "started",
		}))
		a.sendCallEventToUsername(session.CalleeUsername, "im.call.ringing", a.buildCallEventPayload(session, session.CalleeUsername, map[string]any{
			"reason": "incoming_request",
		}))
		return true
	case "im.call.accept":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			sendError("call_not_found", "call not found")
			return true
		}
		if a.callUserRole(session, username) != "callee" {
			sendError("forbidden", "forbidden")
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
		a.broadcastCallSessionEvent(session, "im.call.accepted", nil)
		a.broadcastCallSessionEvent(session, "im.call.connected", nil)
		return true
	case "im.call.reject":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			return true
		}
		role := a.callUserRole(session, username)
		if role == "" {
			sendError("forbidden", "forbidden")
			return true
		}
		session.Status = IMCallStatusFailed
		session.EndedAt = time.Now()
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.failed", map[string]any{
			"reason":     "rejected",
			"actor":      normalizeCallUsername(username),
			"actor_role": role,
		})
		if _, emitted, err := a.emitCallOutcomeMessage(r.Context(), session, "rejected", username, role); err != nil {
			log.Printf("emit call outcome failed: call_id=%s reason=rejected err=%v", session.CallID, err)
		} else if emitted {
			log.Printf("emit call outcome: call_id=%s outcome=rejected", session.CallID)
		}
		a.deleteCallSession(session.CallID)
		return true
	case "im.call.hangup":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			return true
		}
		role := a.callUserRole(session, username)
		if role == "" {
			sendError("forbidden", "forbidden")
			return true
		}
		session.Status = IMCallStatusEnded
		session.EndedAt = time.Now()
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.ended", map[string]any{
			"reason":     "hangup",
			"actor":      normalizeCallUsername(username),
			"actor_role": role,
		})
		if _, emitted, err := a.emitCallOutcomeMessage(r.Context(), session, "hangup", username, role); err != nil {
			log.Printf("emit call outcome failed: call_id=%s reason=hangup err=%v", session.CallID, err)
		} else if emitted {
			log.Printf("emit call outcome: call_id=%s outcome=hangup", session.CallID)
		}
		a.deleteCallSession(session.CallID)
		return true
	case "im.call.mute":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			return true
		}
		role := a.callUserRole(session, username)
		if role == "" {
			sendError("forbidden", "forbidden")
			return true
		}
		if strings.EqualFold(username, session.CallerUsername) {
			session.CallerMuted = payload.Muted
		} else if strings.EqualFold(username, session.CalleeUsername) {
			session.CalleeMuted = payload.Muted
		}
		session.touch()
		a.broadcastCallSessionEvent(session, "im.call.updated", map[string]any{"muted_by": role})
		return true
	case "im.call.offer", "im.call.answer", "im.call.ice":
		session := a.getCallSession(payload.CallID)
		if session == nil {
			sendError("call_not_found", "call not found")
			return true
		}
		role := a.callUserRole(session, username)
		if role == "" {
			sendError("forbidden", "forbidden")
			return true
		}
		peerUsername := callPeerUsername(session, username)
		if peerUsername == "" {
			sendError("peer_not_found", "peer not found")
			return true
		}
		forward := a.buildCallEventPayload(session, peerUsername, map[string]any{
			"from_username": normalizeCallUsername(username),
			"from_role":     role,
			"to_username":   peerUsername,
		})
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
