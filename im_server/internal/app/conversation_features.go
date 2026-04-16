package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type conversationMeta struct {
	ID               int64
	ConversationType string
	ConversationTitle string
	AvatarURL        string
	OwnerUsername    string
}

type conversationMemberSnapshot struct {
	ID            int64
	Username      string
	JoinedAt      time.Time
	LeftAt        *time.Time
	LastReadSeqNo int64
	PinType       string
	PinnedAt      *time.Time
}

type MessageReadProgressSummary struct {
	TotalCount       int64 `json:"total_count"`
	ReadCount        int64 `json:"read_count"`
	UnreadCount      int64 `json:"unread_count"`
	ProgressPercent  int   `json:"progress_percent"`
	IsFullyRead      bool  `json:"is_fully_read"`
}

type MessageReadProgressMember struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

type MessageReadProgressDetail struct {
	MessageID         int64                       `json:"message_id"`
	ConversationID    int64                       `json:"conversation_id"`
	ReadProgress      MessageReadProgressSummary  `json:"read_progress"`
	UnreadMembers     []MessageReadProgressMember `json:"unread_members"`
}

type pinSessionRequest struct {
	ConversationID int64 `json:"conversation_id"`
	Pinned         bool  `json:"pinned"`
}

type internalWhitelistGroupSyncRequest struct {
	AddedBy string `json:"added_by"`
}

func roundProgressPercent(readCount int64, totalCount int64) int {
	if totalCount <= 0 {
		return 0
	}
	if readCount < 0 {
		readCount = 0
	}
	if readCount > totalCount {
		readCount = totalCount
	}
	return int(math.Round((float64(readCount) * 100) / float64(totalCount)))
}

func isLoopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (a *App) loadConversationMeta(ctx context.Context, conversationID int64) (conversationMeta, error) {
	var meta conversationMeta
	err := a.db.QueryRow(ctx, `
		SELECT id, conversation_type, COALESCE(title, ''), COALESCE(avatar_url, ''), COALESCE(owner_username, '')
		FROM im_conversation
		WHERE id = $1 AND deleted_at IS NULL`, conversationID).
		Scan(&meta.ID, &meta.ConversationType, &meta.ConversationTitle, &meta.AvatarURL, &meta.OwnerUsername)
	if err != nil {
		return conversationMeta{}, err
	}
	return meta, nil
}

func (a *App) listConversationMembers(ctx context.Context, conversationID int64) ([]conversationMemberSnapshot, error) {
	rows, err := a.db.Query(ctx, `
		SELECT id, username, joined_at, left_at, last_read_seq_no, COALESCE(pin_type, 'none') AS pin_type, pinned_at
		FROM im_conversation_member
		WHERE conversation_id = $1
		ORDER BY id ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]conversationMemberSnapshot, 0)
	for rows.Next() {
		var item conversationMemberSnapshot
		if err := rows.Scan(&item.ID, &item.Username, &item.JoinedAt, &item.LeftAt, &item.LastReadSeqNo, &item.PinType, &item.PinnedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func memberEffectiveAt(item conversationMemberSnapshot, sentAt time.Time) bool {
	if sentAt.IsZero() {
		return item.LeftAt == nil
	}
	if item.JoinedAt.After(sentAt) {
		return false
	}
	if item.LeftAt != nil && !item.LeftAt.After(sentAt) {
		return false
	}
	return true
}

func buildMessageReadProgressSummary(members []conversationMemberSnapshot, senderUsername string, seqNo int64, sentAt time.Time) MessageReadProgressSummary {
	normalizedSender := strings.ToLower(strings.TrimSpace(senderUsername))
	var totalCount int64
	var readCount int64
	for _, member := range members {
		if !memberEffectiveAt(member, sentAt) {
			continue
		}
		totalCount += 1
		if strings.ToLower(strings.TrimSpace(member.Username)) == normalizedSender || member.LastReadSeqNo >= seqNo {
			readCount += 1
		}
	}
	if totalCount <= 0 {
		return MessageReadProgressSummary{}
	}
	unreadCount := totalCount - readCount
	if unreadCount < 0 {
		unreadCount = 0
	}
	progressPercent := roundProgressPercent(readCount, totalCount)
	return MessageReadProgressSummary{
		TotalCount:      totalCount,
		ReadCount:       readCount,
		UnreadCount:     unreadCount,
		ProgressPercent: progressPercent,
		IsFullyRead:     readCount >= totalCount,
	}
}

func (a *App) buildMessageReadProgressDetail(ctx context.Context, messageID int64, username string) (MessageReadProgressDetail, error) {
	var conversationID int64
	var senderUsername string
	var seqNo int64
	var sentAt time.Time
	err := a.db.QueryRow(ctx, `
		SELECT conversation_id, sender_username, seq_no, sent_at
		FROM im_message
		WHERE id = $1 AND deleted_at IS NULL`, messageID).
		Scan(&conversationID, &senderUsername, &seqNo, &sentAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MessageReadProgressDetail{}, errors.New("message not found")
		}
		return MessageReadProgressDetail{}, err
	}
	if !a.ensureConversationMember(ctx, fmt.Sprintf("%d", conversationID), username) {
		return MessageReadProgressDetail{}, errors.New("forbidden")
	}
	members, err := a.listConversationMembers(ctx, conversationID)
	if err != nil {
		return MessageReadProgressDetail{}, err
	}
	summary := buildMessageReadProgressSummary(members, senderUsername, seqNo, sentAt)
	unreadMembers := make([]MessageReadProgressMember, 0)
	normalizedSender := strings.ToLower(strings.TrimSpace(senderUsername))
	cache := map[string]string{}
	for _, member := range members {
		if !memberEffectiveAt(member, sentAt) {
			continue
		}
		normalizedUsername := strings.ToLower(strings.TrimSpace(member.Username))
		if normalizedUsername == normalizedSender {
			continue
		}
		if member.LastReadSeqNo >= seqNo {
			continue
		}
		displayName, ok := cache[normalizedUsername]
		if !ok {
			displayName = a.fetchDisplayName(ctx, normalizedUsername)
			cache[normalizedUsername] = displayName
		}
		unreadMembers = append(unreadMembers, MessageReadProgressMember{
			Username:    normalizedUsername,
			DisplayName: displayName,
		})
	}
	sort.Slice(unreadMembers, func(left int, right int) bool {
		leftName := strings.TrimSpace(unreadMembers[left].DisplayName)
		rightName := strings.TrimSpace(unreadMembers[right].DisplayName)
		if leftName == rightName {
			return unreadMembers[left].Username < unreadMembers[right].Username
		}
		return leftName < rightName
	})
	return MessageReadProgressDetail{
		MessageID:      messageID,
		ConversationID: conversationID,
		ReadProgress:   summary,
		UnreadMembers:  unreadMembers,
	}, nil
}

func (a *App) populateMessageReadProgress(items []MessageItem, members []conversationMemberSnapshot, viewerUsername string) {
	for index := range items {
		sentAt, err := time.Parse(time.RFC3339, items[index].SentAt)
		if err != nil {
			continue
		}
		summary := buildMessageReadProgressSummary(members, items[index].SenderUsername, items[index].SeqNo, sentAt)
		if summary.TotalCount <= 0 {
			continue
		}
		items[index].ReadProgress = &summary
		items[index].Read = strings.EqualFold(items[index].SenderUsername, viewerUsername) && summary.IsFullyRead
	}
}

func (a *App) handleMessageReadProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	messageIDText := strings.TrimSpace(r.URL.Query().Get("message_id"))
	if messageIDText == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing message_id"})
		return
	}
	var messageID int64
	if _, err := fmt.Sscan(messageIDText, &messageID); err != nil || messageID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid message_id"})
		return
	}
	item, err := a.buildMessageReadProgressDetail(r.Context(), messageID, username)
	if err != nil {
		statusCode := http.StatusBadRequest
		if err.Error() == "message not found" {
			statusCode = http.StatusNotFound
		}
		if err.Error() == "forbidden" {
			statusCode = http.StatusForbidden
		}
		writeJSON(w, statusCode, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) setConversationPin(ctx context.Context, conversationID int64, username string, pinned bool) error {
	var pinType string
	err := a.db.QueryRow(ctx, `
		SELECT COALESCE(pin_type, 'none')
		FROM im_conversation_member
		WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, conversationID, username).
		Scan(&pinType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("conversation not found")
		}
		return err
	}
	if pinned {
		if pinType == "system" {
			return nil
		}
		_, err = a.db.Exec(ctx, `
			UPDATE im_conversation_member
			SET pin_type = 'manual', pinned_at = NOW(), is_pinned = TRUE, updated_at = NOW()
			WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, conversationID, username)
		return err
	}
	if pinType == "system" {
		return errors.New("system pinned conversation cannot be unpinned")
	}
	_, err = a.db.Exec(ctx, `
		UPDATE im_conversation_member
		SET pin_type = 'none', pinned_at = NULL, is_pinned = FALSE, updated_at = NOW()
		WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, conversationID, username)
	return err
}

func (a *App) handleSessionPin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req pinSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	if err := a.setConversationPin(r.Context(), req.ConversationID, username, req.Pinned); err != nil {
		statusCode := http.StatusBadRequest
		if err.Error() == "conversation not found" {
			statusCode = http.StatusNotFound
		}
		writeJSON(w, statusCode, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.hub.send(username, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func normalizeUsernames(items []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(items))
	for _, item := range items {
		username := strings.ToLower(strings.TrimSpace(item))
		if username == "" {
			continue
		}
		if _, ok := seen[username]; ok {
			continue
		}
		seen[username] = struct{}{}
		result = append(result, username)
	}
	sort.Strings(result)
	return result
}

func (a *App) loadWhitelistGroupMembers(ctx context.Context, addedBy string) (map[string][]string, error) {
	query := `
		SELECT LOWER(username) AS username, LOWER(COALESCE(added_by, '')) AS added_by
		FROM authorized_accounts
		WHERE status = 'active' AND expire_time > NOW() AND COALESCE(added_by, '') <> ''`
	args := make([]any, 0, 1)
	if addedBy != "" {
		query += ` AND LOWER(added_by) = $1`
		args = append(args, strings.ToLower(strings.TrimSpace(addedBy)))
	}
	query += ` ORDER BY added_by ASC, username ASC`
	rows, err := a.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string][]string{}
	for rows.Next() {
		var username string
		var owner string
		if err := rows.Scan(&username, &owner); err != nil {
			return nil, err
		}
		if username == "" || owner == "" || username == owner {
			continue
		}
		result[owner] = append(result[owner], username)
	}
	for owner, items := range result {
		result[owner] = normalizeUsernames(items)
	}
	return result, rows.Err()
}

func (a *App) loadExistingWhitelistGroupAdmins(ctx context.Context, addedBy string) ([]string, error) {
	query := `
		SELECT DISTINCT LOWER(COALESCE(owner_username, '')) AS owner_username
		FROM im_conversation
		WHERE conversation_type = 'group' AND conversation_key LIKE 'group:admin_whitelist:%'`
	args := make([]any, 0, 1)
	if addedBy != "" {
		query += ` AND LOWER(owner_username) = $1`
		args = append(args, strings.ToLower(strings.TrimSpace(addedBy)))
	}
	rows, err := a.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0)
	for rows.Next() {
		var owner string
		if err := rows.Scan(&owner); err != nil {
			return nil, err
		}
		owner = strings.ToLower(strings.TrimSpace(owner))
		if owner != "" {
			items = append(items, owner)
		}
	}
	return normalizeUsernames(items), rows.Err()
}

func (a *App) syncWhitelistGroupByAdmin(ctx context.Context, addedBy string, members []string) error {
	normalizedOwner := strings.ToLower(strings.TrimSpace(addedBy))
	if normalizedOwner == "" {
		return nil
	}
	desiredMembers := normalizeUsernames(members)
	conversationKey := "group:admin_whitelist:" + normalizedOwner
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var conversationID int64
	err = tx.QueryRow(ctx, `SELECT id FROM im_conversation WHERE conversation_key = $1`, conversationKey).Scan(&conversationID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	affectedUsers := map[string]struct{}{}
	if len(desiredMembers) < 2 {
		if errors.Is(err, pgx.ErrNoRows) {
			return tx.Commit(ctx)
		}
		rows, queryErr := tx.Query(ctx, `SELECT DISTINCT username FROM im_conversation_member WHERE conversation_id = $1 AND left_at IS NULL`, conversationID)
		if queryErr != nil {
			return queryErr
		}
		for rows.Next() {
			var username string
			if scanErr := rows.Scan(&username); scanErr == nil {
				affectedUsers[strings.ToLower(strings.TrimSpace(username))] = struct{}{}
			}
		}
		rows.Close()
		if _, execErr := tx.Exec(ctx, `
			UPDATE im_conversation_member
			SET left_at = COALESCE(left_at, NOW()), pin_type = 'none', pinned_at = NULL, is_pinned = FALSE, updated_at = NOW()
			WHERE conversation_id = $1 AND left_at IS NULL`, conversationID); execErr != nil {
			return execErr
		}
		if _, execErr := tx.Exec(ctx, `UPDATE im_conversation SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, conversationID); execErr != nil {
			return execErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return commitErr
		}
		if len(affectedUsers) > 0 {
			a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID}})
		}
		return nil
	}
	title := fmt.Sprintf("%s 白名单群", a.fetchDisplayName(ctx, normalizedOwner))
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_conversation (conversation_type, conversation_key, title, owner_username)
			VALUES ('group', $1, $2, $3)
			ON CONFLICT DO NOTHING`, conversationKey, title, normalizedOwner); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT id FROM im_conversation WHERE conversation_key = $1`, conversationKey).Scan(&conversationID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE im_conversation
		SET conversation_type = 'group', title = $2, owner_username = $3, deleted_at = NULL, updated_at = NOW()
		WHERE id = $1`, conversationID, title, normalizedOwner); err != nil {
		return err
	}
	activeRows, err := tx.Query(ctx, `
		SELECT id, username
		FROM im_conversation_member
		WHERE conversation_id = $1 AND left_at IS NULL`, conversationID)
	if err != nil {
		return err
	}
	activeMembers := map[string]int64{}
	for activeRows.Next() {
		var memberID int64
		var username string
		if scanErr := activeRows.Scan(&memberID, &username); scanErr != nil {
			activeRows.Close()
			return scanErr
		}
		normalizedUsername := strings.ToLower(strings.TrimSpace(username))
		activeMembers[normalizedUsername] = memberID
		affectedUsers[normalizedUsername] = struct{}{}
	}
	activeRows.Close()
	desiredSet := map[string]struct{}{}
	for _, member := range desiredMembers {
		desiredSet[member] = struct{}{}
		affectedUsers[member] = struct{}{}
		if _, ok := activeMembers[member]; ok {
			if _, err := tx.Exec(ctx, `
				UPDATE im_conversation_member
				SET pin_type = 'system', pinned_at = COALESCE(pinned_at, NOW()), is_pinned = TRUE, updated_at = NOW()
				WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, conversationID, member); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_conversation_member (conversation_id, username, role, pin_type, pinned_at, is_pinned)
			VALUES ($1, $2, 'member', 'system', NOW(), TRUE)
			ON CONFLICT DO NOTHING`, conversationID, member); err != nil {
			return err
		}
	}
	for member := range activeMembers {
		if _, ok := desiredSet[member]; ok {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE im_conversation_member
			SET left_at = NOW(), pin_type = 'none', pinned_at = NULL, is_pinned = FALSE, updated_at = NOW()
			WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, conversationID, member); err != nil {
			return err
		}
	}
	if commitErr := tx.Commit(ctx); commitErr != nil {
		return commitErr
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID}})
	return nil
}

func (a *App) syncWhitelistGroups(ctx context.Context, addedBy string) (int, error) {
	targetOwner := strings.ToLower(strings.TrimSpace(addedBy))
	memberMap, err := a.loadWhitelistGroupMembers(ctx, targetOwner)
	if err != nil {
		return 0, err
	}
	existingOwners, err := a.loadExistingWhitelistGroupAdmins(ctx, targetOwner)
	if err != nil {
		return 0, err
	}
	ownerSet := map[string]struct{}{}
	for owner := range memberMap {
		ownerSet[owner] = struct{}{}
	}
	for _, owner := range existingOwners {
		ownerSet[owner] = struct{}{}
	}
	if targetOwner != "" {
		ownerSet[targetOwner] = struct{}{}
	}
	owners := make([]string, 0, len(ownerSet))
	for owner := range ownerSet {
		owners = append(owners, owner)
	}
	sort.Strings(owners)
	syncedCount := 0
	for _, owner := range owners {
		if err := a.syncWhitelistGroupByAdmin(ctx, owner, memberMap[owner]); err != nil {
			return syncedCount, err
		}
		syncedCount += 1
	}
	return syncedCount, nil
}

func (a *App) handleInternalWhitelistGroupSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	var req internalWhitelistGroupSyncRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	syncedCount, err := a.syncWhitelistGroups(r.Context(), req.AddedBy)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "synced_count": syncedCount})
}

func (a *App) broadcastUsernames(usernames map[string]struct{}, payload map[string]any) {
	for username := range usernames {
		normalizedUsername := strings.ToLower(strings.TrimSpace(username))
		if normalizedUsername == "" {
			continue
		}
		a.hub.send(normalizedUsername, payload)
	}
}
