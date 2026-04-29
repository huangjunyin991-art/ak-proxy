package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	errGroupMemberMuted = errors.New("你已被禁言")
	errGroupAllMuted    = errors.New("全体禁言中，仅群主和管理员可发言")
)

type groupAdminManageRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Username       string `json:"username"`
}

type groupMemberMuteRequest struct {
	ConversationID  int64  `json:"conversation_id"`
	Username        string `json:"username"`
	DurationSeconds int64  `json:"duration_seconds"`
}

type groupAllMuteUpdateRequest struct {
	ConversationID int64 `json:"conversation_id"`
	Enabled        bool  `json:"enabled"`
}

func isGroupMuteSendError(err error) bool {
	return errors.Is(err, errGroupMemberMuted) || errors.Is(err, errGroupAllMuted)
}

func normalizeGroupTargetUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func formatOptionalTime(value *time.Time) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.Format(time.RFC3339)
}

func allowedMuteDuration(seconds int64) bool {
	switch seconds {
	case int64(time.Hour / time.Second), int64(2 * time.Hour / time.Second), int64(3 * time.Hour / time.Second), int64(24 * time.Hour / time.Second), int64(72 * time.Hour / time.Second):
		return true
	default:
		return false
	}
}

func groupRoleRank(role string) int {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "owner":
		return 3
	case "admin":
		return 2
	default:
		return 1
	}
}

func (a *App) loadConversationRole(ctx context.Context, conversationID int64, username string, meta conversationMeta) (string, error) {
	normalizedUsername := normalizeGroupTargetUsername(username)
	if normalizedUsername == "" {
		return "", errors.New("invalid username")
	}
	if strings.EqualFold(normalizedUsername, meta.OwnerUsername) {
		return "owner", nil
	}
	var exists bool
	if err := a.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM im_conversation_member
			WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL
		)`, conversationID, normalizedUsername).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		return "", errors.New("target user not in group")
	}
	if a.isConversationAdmin(ctx, conversationID, normalizedUsername) {
		return "admin", nil
	}
	return "member", nil
}

func canManageGroupMemberTarget(actorRole string, targetRole string) bool {
	actorRank := groupRoleRank(actorRole)
	targetRank := groupRoleRank(targetRole)
	if actorRank < 2 {
		return false
	}
	if targetRank >= 3 {
		return false
	}
	if actorRank == 2 && targetRank >= 2 {
		return false
	}
	return true
}

func (a *App) requireGroupOwner(ctx context.Context, conversationID int64, username string) (conversationMeta, error) {
	if !a.ensureConversationMember(ctx, fmt.Sprintf("%d", conversationID), username) {
		return conversationMeta{}, errors.New("forbidden")
	}
	meta, err := a.loadConversationMeta(ctx, conversationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return conversationMeta{}, errors.New("conversation not found")
		}
		return conversationMeta{}, err
	}
	if meta.ConversationType != "group" {
		return conversationMeta{}, errors.New("conversation not group")
	}
	if !strings.EqualFold(meta.OwnerUsername, username) {
		return conversationMeta{}, errors.New("forbidden")
	}
	return meta, nil
}

func (a *App) handleGroupAdmins(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	conversationIDText := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
	var conversationID int64
	if _, err := fmt.Sscan(conversationIDText, &conversationID); err != nil || conversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	item, err := a.buildConversationGroupProfileItem(r.Context(), conversationID, username, true, false)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) handleGroupAdminAssign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupAdminManageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	target := normalizeGroupTargetUsername(req.Username)
	if req.ConversationID <= 0 || target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	meta, err := a.requireGroupOwner(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if strings.EqualFold(meta.OwnerUsername, target) {
		writeConversationFeatureError(w, errors.New("cannot manage group owner"))
		return
	}
	if _, err := a.loadConversationRole(r.Context(), req.ConversationID, target, meta); err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if err := a.ensureAllowedConversationAdminTarget(r.Context(), meta, target); err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if _, err := a.db.Exec(r.Context(), `
		INSERT INTO im_conversation_admin (conversation_id, username, assigned_by)
		SELECT $1, $2, $3
		WHERE NOT EXISTS (
			SELECT 1 FROM im_conversation_admin WHERE conversation_id = $1 AND username = $2 AND revoked_at IS NULL
		)`, req.ConversationID, target, username); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "admins_changed"}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleGroupAdminRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupAdminManageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	target := normalizeGroupTargetUsername(req.Username)
	if req.ConversationID <= 0 || target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	meta, err := a.requireGroupOwner(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if strings.EqualFold(meta.OwnerUsername, target) {
		writeConversationFeatureError(w, errors.New("cannot manage group owner"))
		return
	}
	if _, err := a.loadConversationRole(r.Context(), req.ConversationID, target, meta); err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if _, err := a.db.Exec(r.Context(), `
		UPDATE im_conversation_admin
		SET revoked_at = NOW(), updated_at = NOW()
		WHERE conversation_id = $1 AND username = $2 AND revoked_at IS NULL`, req.ConversationID, target); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "admins_changed"}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSessionMemberMute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupMemberMuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	target := normalizeGroupTargetUsername(req.Username)
	if req.ConversationID <= 0 || target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	if !allowedMuteDuration(req.DurationSeconds) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid mute duration"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	actorRole, err := a.loadConversationRole(r.Context(), req.ConversationID, username, meta)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	targetRole, err := a.loadConversationRole(r.Context(), req.ConversationID, target, meta)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if !canManageGroupMemberTarget(actorRole, targetRole) {
		writeConversationFeatureError(w, errors.New("forbidden"))
		return
	}
	mutedUntil := time.Now().Add(time.Duration(req.DurationSeconds) * time.Second)
	if _, err := a.db.Exec(r.Context(), `
		UPDATE im_conversation_member
		SET mute_until = $3, muted_by = $4, updated_at = NOW()
		WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, req.ConversationID, target, mutedUntil, username); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "member_muted", "username": target}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "muted_until": mutedUntil.Format(time.RFC3339)})
}

func (a *App) handleSessionMemberUnmute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupAdminManageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	target := normalizeGroupTargetUsername(req.Username)
	if req.ConversationID <= 0 || target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	actorRole, err := a.loadConversationRole(r.Context(), req.ConversationID, username, meta)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	targetRole, err := a.loadConversationRole(r.Context(), req.ConversationID, target, meta)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if !canManageGroupMemberTarget(actorRole, targetRole) {
		writeConversationFeatureError(w, errors.New("forbidden"))
		return
	}
	if _, err := a.db.Exec(r.Context(), `
		UPDATE im_conversation_member
		SET mute_until = NULL, muted_by = '', updated_at = NOW()
		WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, req.ConversationID, target); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "member_unmuted", "username": target}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleGroupAllMuteUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req groupAllMuteUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	if req.Enabled {
		_, err = a.db.Exec(r.Context(), `
			UPDATE im_conversation
			SET all_muted = TRUE, all_muted_by = $2, all_muted_at = NOW(), updated_at = NOW()
			WHERE id = $1`, req.ConversationID, username)
	} else {
		_, err = a.db.Exec(r.Context(), `
			UPDATE im_conversation
			SET all_muted = FALSE, all_muted_by = '', all_muted_at = NULL, updated_at = NOW()
			WHERE id = $1`, req.ConversationID)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "all_mute_changed", "conversation_title": meta.ConversationTitle, "all_muted": req.Enabled}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "all_muted": req.Enabled})
}

func (a *App) assertGroupCanSendMessageTx(ctx context.Context, tx pgx.Tx, conversationID int64, username string) error {
	normalizedUsername := normalizeGroupTargetUsername(username)
	if normalizedUsername == "" || conversationID <= 0 {
		return nil
	}
	var conversationType string
	var ownerUsername string
	var allMuted bool
	var muteUntil *time.Time
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(c.conversation_type, ''), COALESCE(c.owner_username, ''), COALESCE(c.all_muted, FALSE), cm.mute_until
		FROM im_conversation c
		JOIN im_conversation_member cm ON cm.conversation_id = c.id AND cm.username = $2 AND cm.left_at IS NULL
		WHERE c.id = $1 AND c.deleted_at IS NULL`, conversationID, normalizedUsername).Scan(&conversationType, &ownerUsername, &allMuted, &muteUntil)
	if err != nil {
		return err
	}
	if conversationType != "group" {
		return nil
	}
	now := time.Now()
	if muteUntil != nil && muteUntil.After(now) {
		return errGroupMemberMuted
	}
	if !allMuted {
		return nil
	}
	if strings.EqualFold(ownerUsername, normalizedUsername) {
		return nil
	}
	var isAdmin bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM im_conversation_admin
			WHERE conversation_id = $1 AND username = $2 AND revoked_at IS NULL
		)`, conversationID, normalizedUsername).Scan(&isAdmin); err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	return errGroupAllMuted
}
