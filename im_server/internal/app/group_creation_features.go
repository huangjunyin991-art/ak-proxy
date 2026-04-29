package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type groupSessionCreateRequest struct {
	Title     string   `json:"title"`
	Usernames []string `json:"usernames"`
}

type groupTitleUpdateRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Title          string `json:"title"`
}

func normalizeGroupTitle(title string) string {
	return strings.TrimSpace(title)
}

func (a *App) validateGroupCreateTargets(ctx context.Context, owner string, requestedUsernames []string) ([]string, error) {
	owner = strings.ToLower(strings.TrimSpace(owner))
	contacts, _, err := a.listContactResponse(ctx, owner)
	if err != nil {
		return nil, err
	}
	contactSet := map[string]struct{}{}
	for _, contact := range contacts {
		username := strings.ToLower(strings.TrimSpace(contact.Username))
		if username != "" {
			contactSet[username] = struct{}{}
		}
	}
	targets := make([]string, 0)
	for _, username := range normalizeUsernames(requestedUsernames) {
		if username == "" || username == owner {
			continue
		}
		if _, ok := contactSet[username]; !ok {
			return nil, errors.New("target user not in contacts")
		}
		if err := a.ensureAllowedConversationTarget(ctx, username); err != nil {
			return nil, err
		}
		targets = append(targets, username)
	}
	if len(targets) < 2 {
		return nil, errors.New("at least two contacts required")
	}
	return targets, nil
}

func (a *App) createGroupConversation(ctx context.Context, owner string, title string, targetUsernames []string) (int64, error) {
	normalizedOwner := strings.ToLower(strings.TrimSpace(owner))
	normalizedTitle := normalizeGroupTitle(title)
	if normalizedOwner == "" {
		return 0, errors.New("invalid username")
	}
	if normalizedTitle == "" {
		return 0, errors.New("invalid group title")
	}
	targets, err := a.validateGroupCreateTargets(ctx, normalizedOwner, targetUsernames)
	if err != nil {
		return 0, err
	}
	members := normalizeUsernames(append([]string{normalizedOwner}, targets...))
	conversationKey := fmt.Sprintf("group:user:%s:%d", normalizedOwner, time.Now().UnixNano())
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var conversationID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO im_conversation (conversation_type, conversation_key, title, owner_username)
		VALUES ('group', $1, $2, $3)
		RETURNING id`, conversationKey, normalizedTitle, normalizedOwner).Scan(&conversationID); err != nil {
		return 0, err
	}
	for _, member := range members {
		role := "member"
		if member == normalizedOwner {
			role = "owner"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_conversation_member (conversation_id, username, role)
			VALUES ($1, $2, $3)`, conversationID, member, role); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_conversation_admin (conversation_id, username, assigned_by)
		VALUES ($1, $2, $3)`, conversationID, normalizedOwner, normalizedOwner); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	affectedUsers := map[string]struct{}{}
	for _, member := range members {
		affectedUsers[member] = struct{}{}
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID, "reason": "group_created", "conversation_title": normalizedTitle}})
	return conversationID, nil
}

func (a *App) updateGroupConversationTitle(ctx context.Context, conversationID int64, username string, title string) error {
	normalizedTitle := normalizeGroupTitle(title)
	if conversationID <= 0 {
		return errors.New("invalid conversation_id")
	}
	if normalizedTitle == "" {
		return errors.New("invalid group title")
	}
	if _, err := a.requireGroupConversationAdmin(ctx, conversationID, username); err != nil {
		return err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	affectedUsers, err := collectConversationAffectedUsersTx(ctx, tx, conversationID)
	if err != nil {
		return err
	}
	commandTag, err := tx.Exec(ctx, `
		UPDATE im_conversation
		SET title = $2, updated_at = NOW()
		WHERE id = $1 AND conversation_type = 'group' AND deleted_at IS NULL`, conversationID, normalizedTitle)
	if err != nil {
		return err
	}
	if commandTag.RowsAffected() <= 0 {
		return errors.New("conversation not found")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID, "reason": "title_updated", "conversation_title": normalizedTitle}})
	return nil
}

func (a *App) handleGroupSessionCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupSessionCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	conversationID, err := a.createGroupConversation(r.Context(), username, req.Title, req.Usernames)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "conversation_id": conversationID, "conversation_title": normalizeGroupTitle(req.Title)})
}

func (a *App) handleGroupTitleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupTitleUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if err := a.updateGroupConversationTitle(r.Context(), req.ConversationID, username, req.Title); err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "conversation_id": req.ConversationID, "conversation_title": normalizeGroupTitle(req.Title)})
}
