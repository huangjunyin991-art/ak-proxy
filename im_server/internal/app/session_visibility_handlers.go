package app

import (
	"encoding/json"
	"net/http"
)

func usernameListToSet(items []string) map[string]struct{} {
	result := map[string]struct{}{}
	for _, item := range items {
		if item != "" {
			result[item] = struct{}{}
		}
	}
	return result
}

func (a *App) handleHiddenGroups(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.sessionVisibility == nil {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	items, err := a.sessionVisibility.ListHiddenGroups(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleHiddenGroupRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.sessionVisibility == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "session visibility service unavailable"})
		return
	}
	var req sessionHideRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	result, err := a.sessionVisibility.RestoreGroup(r.Context(), username, req.ConversationID)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	a.broadcastUsernames(usernameListToSet(result.AffectedUsernames), map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "restored", "conversation_title": result.Item.ConversationTitle}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "item": result.Item})
}
