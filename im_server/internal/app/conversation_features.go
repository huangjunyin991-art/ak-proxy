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

const whitelistMainGroupTitle = "玩家主群"
const whitelistGroupKeyPrefix = "group:admin_whitelist:"

type conversationMeta struct {
	ID                int64
	ConversationType  string
	ConversationKey   string
	ConversationTitle string
	AvatarURL         string
	OwnerUsername     string
	HiddenForAll      bool
	PurgedBeforeSeqNo int64
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

type SessionMemberItem struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Role        string `json:"role,omitempty"`
}

type SessionMembersItem struct {
	ConversationID    int64               `json:"conversation_id"`
	ConversationType  string              `json:"conversation_type"`
	ConversationTitle string              `json:"conversation_title,omitempty"`
	MemberCount       int64               `json:"member_count"`
	Members           []SessionMemberItem `json:"members"`
}

type SessionSettingsItem struct {
	ConversationID    int64               `json:"conversation_id"`
	ConversationType  string              `json:"conversation_type"`
	ConversationTitle string              `json:"conversation_title,omitempty"`
	MemberCount       int64               `json:"member_count"`
	HiddenForAll      bool                `json:"hidden_for_all"`
	IsGroupAdmin      bool                `json:"is_group_admin"`
	CanManage         bool                `json:"can_manage"`
	Admins            []SessionMemberItem `json:"admins"`
	MessageAuthors    []SessionMemberItem `json:"message_authors,omitempty"`
}

type SessionGroupProfileItem struct {
	ConversationID     int64               `json:"conversation_id"`
	ConversationType   string              `json:"conversation_type"`
	ConversationTitle  string              `json:"conversation_title,omitempty"`
	MemberCount        int64               `json:"member_count"`
	HiddenForAll       bool                `json:"hidden_for_all"`
	IsGroupAdmin       bool                `json:"is_group_admin"`
	CanManage          bool                `json:"can_manage"`
	IsWhitelistManaged bool                `json:"is_whitelist_managed"`
	Owner              SessionMemberItem   `json:"owner"`
	Members            []SessionMemberItem `json:"members"`
	Admins             []SessionMemberItem `json:"admins"`
	MessageAuthors     []SessionMemberItem `json:"message_authors,omitempty"`
}

type pinSessionRequest struct {
	ConversationID int64 `json:"conversation_id"`
	Pinned         bool  `json:"pinned"`
}

type internalWhitelistGroupSyncRequest struct {
	AddedBy string `json:"added_by"`
}

type internalGroupAdminsReplaceRequest struct {
	ConversationID int64    `json:"conversation_id"`
	Usernames      []string `json:"usernames"`
	AssignedBy     string   `json:"assigned_by"`
}

type internalGroupProfileRequest struct {
	ConversationID int64 `json:"conversation_id"`
}

type internalGroupOwnerTransferRequest struct {
	ConversationID int64  `json:"conversation_id"`
	OwnerUsername  string `json:"owner_username"`
	TransferredBy  string `json:"transferred_by"`
}

type sessionMembersManageRequest struct {
	ConversationID int64    `json:"conversation_id"`
	Username       string   `json:"username"`
	Usernames      []string `json:"usernames"`
}

type sessionHistoryClearRequest struct {
	ConversationID int64 `json:"conversation_id"`
}

type sessionMemberHistoryClearRequest struct {
	ConversationID int64    `json:"conversation_id"`
	Username       string   `json:"username"`
	Usernames      []string `json:"usernames"`
}

type sessionHideRequest struct {
	ConversationID int64 `json:"conversation_id"`
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
		SELECT id, conversation_type, COALESCE(conversation_key, ''), COALESCE(title, ''), COALESCE(avatar_url, ''), COALESCE(owner_username, ''), COALESCE(hidden_for_all, FALSE), COALESCE(purged_before_seq_no, 0)
		FROM im_conversation
		WHERE id = $1 AND deleted_at IS NULL`, conversationID).
		Scan(&meta.ID, &meta.ConversationType, &meta.ConversationKey, &meta.ConversationTitle, &meta.AvatarURL, &meta.OwnerUsername, &meta.HiddenForAll, &meta.PurgedBeforeSeqNo)
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

func collectRequestedUsernames(primary string, items []string) []string {
	merged := make([]string, 0, len(items)+1)
	if strings.TrimSpace(primary) != "" {
		merged = append(merged, primary)
	}
	merged = append(merged, items...)
	return normalizeUsernames(merged)
}

func isWhitelistManagedConversation(meta conversationMeta) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(meta.ConversationKey)), whitelistGroupKeyPrefix)
}

func extractWhitelistGroupAdminKey(conversationKey string) string {
	normalizedKey := strings.ToLower(strings.TrimSpace(conversationKey))
	if !strings.HasPrefix(normalizedKey, whitelistGroupKeyPrefix) {
		return ""
	}
	return strings.TrimPrefix(normalizedKey, whitelistGroupKeyPrefix)
}

func whitelistGroupOwnerAssignmentTag(adminKey string) string {
	normalizedAdminKey := strings.ToLower(strings.TrimSpace(adminKey))
	if normalizedAdminKey == "" {
		return "whitelist_owner"
	}
	return "whitelist_owner:" + normalizedAdminKey
}

func (a *App) ensureAllowedConversationTarget(ctx context.Context, username string) error {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return errors.New("invalid username")
	}
	var exists bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_stats WHERE username = $1)`, normalizedUsername).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errors.New("user not found")
	}
	var allowed bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM authorized_accounts WHERE username = $1 AND status = 'active' AND expire_time > NOW())`, normalizedUsername).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return errors.New("user not allowed")
	}
	return nil
}

func (a *App) ensureAllowedConversationOwnerTarget(ctx context.Context, username string) error {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return errors.New("invalid owner_username")
	}
	if normalizedUsername == "super_admin" {
		return nil
	}
	var bindingTableName *string
	if err := a.db.QueryRow(ctx, `SELECT to_regclass('public.sub_admin_account_bindings')`).Scan(&bindingTableName); err != nil {
		return err
	}
	if bindingTableName != nil && strings.TrimSpace(*bindingTableName) != "" {
		var boundExists bool
		if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sub_admin_account_bindings WHERE LOWER(account_username) = $1)`, normalizedUsername).Scan(&boundExists); err != nil {
			return err
		}
		if boundExists {
			return nil
		}
	}
	var exists bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sub_admins WHERE LOWER(name) = $1)`, normalizedUsername).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errors.New("owner not found")
	}
	return nil
}

func (a *App) ensureAllowedConversationAdminTarget(ctx context.Context, meta conversationMeta, username string) error {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	normalizedOwner := strings.ToLower(strings.TrimSpace(meta.OwnerUsername))
	if normalizedUsername == "" {
		return errors.New("invalid username")
	}
	if normalizedOwner != "" && normalizedUsername == normalizedOwner && isWhitelistManagedConversation(meta) {
		return a.ensureAllowedConversationOwnerTarget(ctx, normalizedUsername)
	}
	return a.ensureAllowedConversationTarget(ctx, normalizedUsername)
}

func (a *App) isConversationAdmin(ctx context.Context, conversationID int64, username string) bool {
	var exists bool
	_ = a.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM im_conversation_admin
			WHERE conversation_id = $1 AND username = $2 AND revoked_at IS NULL
		)`, conversationID, strings.ToLower(strings.TrimSpace(username))).Scan(&exists)
	return exists
}

func (a *App) loadConversationAdminUsernames(ctx context.Context, conversationID int64) ([]string, error) {
	rows, err := a.db.Query(ctx, `
		SELECT username
		FROM im_conversation_admin
		WHERE conversation_id = $1 AND revoked_at IS NULL
		ORDER BY LOWER(username) ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0)
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		items = append(items, username)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return normalizeUsernames(items), nil
}

func loadConversationAdminUsernamesTx(ctx context.Context, tx pgx.Tx, conversationID int64) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT username
		FROM im_conversation_admin
		WHERE conversation_id = $1 AND revoked_at IS NULL
		ORDER BY LOWER(username) ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0)
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		items = append(items, username)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return normalizeUsernames(items), nil
}

func loadConversationMemberOverridesTx(ctx context.Context, tx pgx.Tx, conversationID int64) (map[string]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT username, override_type
		FROM im_conversation_member_override
		WHERE conversation_id = $1
		ORDER BY id ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := map[string]string{}
	for rows.Next() {
		var username string
		var overrideType string
		if err := rows.Scan(&username, &overrideType); err != nil {
			return nil, err
		}
		normalizedUsername := strings.ToLower(strings.TrimSpace(username))
		normalizedType := strings.ToLower(strings.TrimSpace(overrideType))
		if normalizedUsername == "" || (normalizedType != "add" && normalizedType != "remove") {
			continue
		}
		items[normalizedUsername] = normalizedType
	}
	return items, rows.Err()
}

func loadActiveConversationUsernamesTx(ctx context.Context, tx pgx.Tx, conversationID int64) (map[string]struct{}, error) {
	rows, err := tx.Query(ctx, `
		SELECT username
		FROM im_conversation_member
		WHERE conversation_id = $1 AND left_at IS NULL`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := map[string]struct{}{}
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		normalizedUsername := strings.ToLower(strings.TrimSpace(username))
		if normalizedUsername != "" {
			items[normalizedUsername] = struct{}{}
		}
	}
	return items, rows.Err()
}

func (a *App) loadConversationAdmins(ctx context.Context, conversationID int64) ([]SessionMemberItem, map[string]struct{}, error) {
	usernames, err := a.loadConversationAdminUsernames(ctx, conversationID)
	if err != nil {
		return nil, nil, err
	}
	items := make([]SessionMemberItem, 0, len(usernames))
	adminSet := map[string]struct{}{}
	for _, username := range usernames {
		adminSet[username] = struct{}{}
		items = append(items, SessionMemberItem{
			Username:    username,
			DisplayName: a.fetchDisplayName(ctx, username),
			AvatarURL:   a.getUserAvatarURL(ctx, username),
			Role:        "admin",
		})
	}
	sort.Slice(items, func(left int, right int) bool {
		leftName := strings.TrimSpace(items[left].DisplayName)
		rightName := strings.TrimSpace(items[right].DisplayName)
		if leftName == rightName {
			return items[left].Username < items[right].Username
		}
		return leftName < rightName
	})
	return items, adminSet, nil
}

func (a *App) loadConversationMemberItems(ctx context.Context, conversationID int64, meta conversationMeta) ([]SessionMemberItem, error) {
	adminUsernames, err := a.loadConversationAdminUsernames(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	adminSet := map[string]struct{}{}
	for _, adminUsername := range adminUsernames {
		adminSet[adminUsername] = struct{}{}
	}
	rows, err := a.db.Query(ctx, `
		SELECT username, COALESCE(role, 'member') AS role
		FROM im_conversation_member
		WHERE conversation_id = $1 AND left_at IS NULL
		ORDER BY LOWER(username) ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := make([]SessionMemberItem, 0)
	for rows.Next() {
		var item SessionMemberItem
		if err := rows.Scan(&item.Username, &item.Role); err != nil {
			return nil, err
		}
		item.Username = strings.ToLower(strings.TrimSpace(item.Username))
		if strings.EqualFold(item.Username, meta.OwnerUsername) {
			item.Role = "owner"
		} else if _, ok := adminSet[item.Username]; ok {
			item.Role = "admin"
		}
		item.DisplayName = a.fetchDisplayName(ctx, item.Username)
		item.AvatarURL = a.getUserAvatarURL(ctx, item.Username)
		members = append(members, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(members, func(left int, right int) bool {
		leftName := strings.TrimSpace(members[left].DisplayName)
		rightName := strings.TrimSpace(members[right].DisplayName)
		if leftName == rightName {
			return members[left].Username < members[right].Username
		}
		return leftName < rightName
	})
	return members, nil
}

func (a *App) buildConversationGroupProfileItem(ctx context.Context, conversationID int64, username string, requireMembership bool, forceCanManage bool) (SessionGroupProfileItem, error) {
	if requireMembership && !a.ensureConversationMember(ctx, fmt.Sprintf("%d", conversationID), username) {
		return SessionGroupProfileItem{}, errors.New("forbidden")
	}
	meta, err := a.loadConversationMeta(ctx, conversationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SessionGroupProfileItem{}, errors.New("conversation not found")
		}
		return SessionGroupProfileItem{}, err
	}
	if meta.ConversationType != "group" {
		return SessionGroupProfileItem{}, errors.New("conversation not group")
	}
	admins, adminSet, err := a.loadConversationAdmins(ctx, conversationID)
	if err != nil {
		return SessionGroupProfileItem{}, err
	}
	for index := range admins {
		if strings.EqualFold(admins[index].Username, meta.OwnerUsername) {
			admins[index].Role = "owner"
		}
	}
	members, err := a.loadConversationMemberItems(ctx, conversationID, meta)
	if err != nil {
		return SessionGroupProfileItem{}, err
	}
	ownerUsername := strings.ToLower(strings.TrimSpace(meta.OwnerUsername))
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	_, isGroupAdmin := adminSet[normalizedUsername]
	if normalizedUsername != "" && strings.EqualFold(normalizedUsername, ownerUsername) {
		isGroupAdmin = true
	}
	canManage := forceCanManage || isGroupAdmin
	item := SessionGroupProfileItem{
		ConversationID:     conversationID,
		ConversationType:   meta.ConversationType,
		ConversationTitle:  meta.ConversationTitle,
		MemberCount:        int64(len(members)),
		HiddenForAll:       meta.HiddenForAll,
		IsGroupAdmin:       isGroupAdmin,
		CanManage:          canManage,
		IsWhitelistManaged: isWhitelistManagedConversation(meta),
		Owner: SessionMemberItem{
			Username:    ownerUsername,
			DisplayName: a.fetchDisplayName(ctx, ownerUsername),
			AvatarURL:   a.getUserAvatarURL(ctx, ownerUsername),
			Role:        "owner",
		},
		Members: members,
		Admins:  admins,
	}
	if strings.TrimSpace(item.ConversationTitle) == "" {
		item.ConversationTitle = whitelistMainGroupTitle
	}
	if canManage {
		authors, err := a.loadConversationMessageAuthors(ctx, conversationID, meta.PurgedBeforeSeqNo)
		if err != nil {
			return SessionGroupProfileItem{}, err
		}
		item.MessageAuthors = authors
	}
	return item, nil
}

func (a *App) loadConversationMessageAuthors(ctx context.Context, conversationID int64, purgedBeforeSeqNo int64) ([]SessionMemberItem, error) {
	rows, err := a.db.Query(ctx, `
		SELECT sender_username
		FROM (
			SELECT DISTINCT sender_username
			FROM im_message
			WHERE conversation_id = $1 AND deleted_at IS NULL AND seq_no > $2
		) authors
		ORDER BY LOWER(sender_username) ASC, sender_username ASC`, conversationID, purgedBeforeSeqNo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]SessionMemberItem, 0)
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		normalizedUsername := strings.ToLower(strings.TrimSpace(username))
		if normalizedUsername == "" {
			continue
		}
		items = append(items, SessionMemberItem{
			Username:    normalizedUsername,
			DisplayName: a.fetchDisplayName(ctx, normalizedUsername),
			AvatarURL:   a.getUserAvatarURL(ctx, normalizedUsername),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(items, func(left int, right int) bool {
		leftName := strings.TrimSpace(items[left].DisplayName)
		rightName := strings.TrimSpace(items[right].DisplayName)
		if leftName == rightName {
			return items[left].Username < items[right].Username
		}
		return leftName < rightName
	})
	return items, nil
}

func refreshConversationSummary(ctx context.Context, tx pgx.Tx, conversationID int64) error {
	var messageID int64
	var preview string
	var sentAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT m.id, COALESCE(m.content_preview, '') AS content_preview, m.sent_at
		FROM im_message m
		JOIN im_conversation c ON c.id = m.conversation_id
		WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND m.seq_no > COALESCE(c.purged_before_seq_no, 0)
		ORDER BY m.seq_no DESC
		LIMIT 1`, conversationID).Scan(&messageID, &preview, &sentAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_, execErr := tx.Exec(ctx, `
				UPDATE im_conversation
				SET last_message_id = NULL, last_message_preview = '', last_message_at = NULL, updated_at = NOW()
				WHERE id = $1`, conversationID)
			return execErr
		}
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE im_conversation
		SET last_message_id = $2, last_message_preview = $3, last_message_at = $4, updated_at = NOW()
		WHERE id = $1`, conversationID, messageID, preview, sentAt)
	return err
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

func (a *App) handleSessionMembers(w http.ResponseWriter, r *http.Request) {
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
	if conversationIDText == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing conversation_id"})
		return
	}
	var conversationID int64
	if _, err := fmt.Sscan(conversationIDText, &conversationID); err != nil || conversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	if !a.ensureConversationMember(r.Context(), conversationIDText, username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	meta, err := a.loadConversationMeta(r.Context(), conversationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "conversation not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	adminUsernames, err := a.loadConversationAdminUsernames(r.Context(), conversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	adminSet := map[string]struct{}{}
	for _, adminUsername := range adminUsernames {
		adminSet[adminUsername] = struct{}{}
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT username, COALESCE(role, 'member') AS role
		FROM im_conversation_member
		WHERE conversation_id = $1 AND left_at IS NULL
		ORDER BY LOWER(username) ASC`, conversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer rows.Close()
	members := make([]SessionMemberItem, 0)
	for rows.Next() {
		var item SessionMemberItem
		if err := rows.Scan(&item.Username, &item.Role); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		item.Username = strings.ToLower(strings.TrimSpace(item.Username))
		if strings.EqualFold(item.Username, meta.OwnerUsername) {
			item.Role = "owner"
		} else if _, ok := adminSet[item.Username]; ok {
			item.Role = "admin"
		}
		item.DisplayName = a.fetchDisplayName(r.Context(), item.Username)
		item.AvatarURL = a.getUserAvatarURL(r.Context(), item.Username)
		members = append(members, item)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	sort.Slice(members, func(left int, right int) bool {
		leftName := strings.TrimSpace(members[left].DisplayName)
		rightName := strings.TrimSpace(members[right].DisplayName)
		if leftName == rightName {
			return members[left].Username < members[right].Username
		}
		return leftName < rightName
	})
	if meta.ConversationType == "group" && strings.TrimSpace(meta.ConversationTitle) == "" {
		meta.ConversationTitle = whitelistMainGroupTitle
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": SessionMembersItem{
		ConversationID:    conversationID,
		ConversationType:  meta.ConversationType,
		ConversationTitle: meta.ConversationTitle,
		MemberCount:       int64(len(members)),
		Members:           members,
	}})
}

func (a *App) handleSessionGroupProfile(w http.ResponseWriter, r *http.Request) {
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
	if conversationIDText == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing conversation_id"})
		return
	}
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

func collectConversationAffectedUsersTx(ctx context.Context, tx pgx.Tx, conversationID int64, extras ...string) (map[string]struct{}, error) {
	activeUsers, err := loadActiveConversationUsernamesTx(ctx, tx, conversationID)
	if err != nil {
		return nil, err
	}
	affectedUsers := map[string]struct{}{}
	for username := range activeUsers {
		affectedUsers[username] = struct{}{}
	}
	for _, item := range extras {
		normalizedUsername := strings.ToLower(strings.TrimSpace(item))
		if normalizedUsername != "" {
			affectedUsers[normalizedUsername] = struct{}{}
		}
	}
	return affectedUsers, nil
}

func writeConversationFeatureError(w http.ResponseWriter, err error) {
	statusCode := http.StatusBadRequest
	switch err.Error() {
	case "forbidden":
		statusCode = http.StatusForbidden
	case "conversation not found":
		statusCode = http.StatusNotFound
	case "invalid username", "user not found", "user not allowed", "conversation not group", "cannot remove group admin", "invalid owner_username", "owner not found", "target owner already has whitelist group":
		statusCode = http.StatusBadRequest
	default:
		statusCode = http.StatusInternalServerError
	}
	writeJSON(w, statusCode, map[string]any{"error": true, "message": err.Error()})
}

func (a *App) requireGroupConversationAdmin(ctx context.Context, conversationID int64, username string) (conversationMeta, error) {
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
	if !a.isConversationAdmin(ctx, conversationID, username) {
		return conversationMeta{}, errors.New("forbidden")
	}
	return meta, nil
}

func (a *App) buildSessionSettingsItem(ctx context.Context, conversationID int64, username string) (SessionSettingsItem, error) {
	if !a.ensureConversationMember(ctx, fmt.Sprintf("%d", conversationID), username) {
		return SessionSettingsItem{}, errors.New("forbidden")
	}
	meta, err := a.loadConversationMeta(ctx, conversationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SessionSettingsItem{}, errors.New("conversation not found")
		}
		return SessionSettingsItem{}, err
	}
	if meta.ConversationType != "group" {
		return SessionSettingsItem{}, errors.New("conversation not group")
	}
	admins, adminSet, err := a.loadConversationAdmins(ctx, conversationID)
	if err != nil {
		return SessionSettingsItem{}, err
	}
	for index := range admins {
		if strings.EqualFold(admins[index].Username, meta.OwnerUsername) {
			admins[index].Role = "owner"
		}
	}
	members, err := a.listConversationMembers(ctx, conversationID)
	if err != nil {
		return SessionSettingsItem{}, err
	}
	memberCount := int64(0)
	for _, member := range members {
		if member.LeftAt == nil {
			memberCount += 1
		}
	}
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	_, isGroupAdmin := adminSet[normalizedUsername]
	item := SessionSettingsItem{
		ConversationID:    conversationID,
		ConversationType:  meta.ConversationType,
		ConversationTitle: meta.ConversationTitle,
		MemberCount:       memberCount,
		HiddenForAll:      meta.HiddenForAll,
		IsGroupAdmin:      isGroupAdmin,
		CanManage:         isGroupAdmin,
		Admins:            admins,
	}
	if strings.TrimSpace(item.ConversationTitle) == "" {
		item.ConversationTitle = whitelistMainGroupTitle
	}
	if isGroupAdmin {
		authors, err := a.loadConversationMessageAuthors(ctx, conversationID, meta.PurgedBeforeSeqNo)
		if err != nil {
			return SessionSettingsItem{}, err
		}
		item.MessageAuthors = authors
	}
	return item, nil
}

func (a *App) handleSessionSettings(w http.ResponseWriter, r *http.Request) {
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
	if conversationIDText == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing conversation_id"})
		return
	}
	var conversationID int64
	if _, err := fmt.Sscan(conversationIDText, &conversationID); err != nil || conversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	item, err := a.buildSessionSettingsItem(r.Context(), conversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) syncWhitelistConversationAfterRules(ctx context.Context, meta conversationMeta) error {
	normalizedAdminKey := extractWhitelistGroupAdminKey(meta.ConversationKey)
	if normalizedAdminKey == "" {
		normalizedAdminKey = strings.ToLower(strings.TrimSpace(meta.OwnerUsername))
	}
	memberMap, err := a.loadWhitelistGroupMembers(ctx, normalizedAdminKey)
	if err != nil {
		return err
	}
	return a.syncWhitelistGroupByAdmin(ctx, normalizedAdminKey, memberMap[normalizedAdminKey])
}

func (a *App) handleSessionMembersAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req sessionMembersManageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	targets := collectRequestedUsernames(req.Username, req.Usernames)
	if len(targets) < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	for _, target := range targets {
		if err := a.ensureAllowedConversationTarget(r.Context(), target); err != nil {
			writeConversationFeatureError(w, err)
			return
		}
	}
	if isWhitelistManagedConversation(meta) {
		tx, err := a.db.Begin(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		defer tx.Rollback(r.Context())
		for _, target := range targets {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO im_conversation_member_override (conversation_id, username, override_type, created_by)
				VALUES ($1, $2, 'add', $3)
				ON CONFLICT (conversation_id, username)
				DO UPDATE SET override_type = 'add', created_by = EXCLUDED.created_by, updated_at = NOW()`, req.ConversationID, target, username); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
				return
			}
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		if err := a.syncWhitelistConversationAfterRules(r.Context(), meta); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	affectedUsers, err := collectConversationAffectedUsersTx(r.Context(), tx, req.ConversationID, targets...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	activeUsers, err := loadActiveConversationUsernamesTx(r.Context(), tx, req.ConversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	for _, target := range targets {
		if _, ok := activeUsers[target]; ok {
			continue
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO im_conversation_member (conversation_id, username, role)
			VALUES ($1, $2, 'member')
			ON CONFLICT DO NOTHING`, req.ConversationID, target); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "members_changed"}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSessionMembersRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req sessionMembersManageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	targets := collectRequestedUsernames(req.Username, req.Usernames)
	if len(targets) < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	adminUsernames, err := a.loadConversationAdminUsernames(r.Context(), req.ConversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	adminSet := map[string]struct{}{}
	for _, adminUsername := range adminUsernames {
		adminSet[adminUsername] = struct{}{}
	}
	for _, target := range targets {
		if _, ok := adminSet[target]; ok {
			writeConversationFeatureError(w, errors.New("cannot remove group admin"))
			return
		}
	}
	if isWhitelistManagedConversation(meta) {
		tx, err := a.db.Begin(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		defer tx.Rollback(r.Context())
		for _, target := range targets {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO im_conversation_member_override (conversation_id, username, override_type, created_by)
				VALUES ($1, $2, 'remove', $3)
				ON CONFLICT (conversation_id, username)
				DO UPDATE SET override_type = 'remove', created_by = EXCLUDED.created_by, updated_at = NOW()`, req.ConversationID, target, username); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
				return
			}
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		if err := a.syncWhitelistConversationAfterRules(r.Context(), meta); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	affectedUsers, err := collectConversationAffectedUsersTx(r.Context(), tx, req.ConversationID, targets...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	for _, target := range targets {
		if _, err := tx.Exec(r.Context(), `
			UPDATE im_conversation_member
			SET left_at = NOW(), pin_type = 'none', pinned_at = NULL, is_pinned = FALSE, updated_at = NOW()
			WHERE conversation_id = $1 AND username = $2 AND left_at IS NULL`, req.ConversationID, target); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "members_changed"}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleSessionHistoryClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req sessionHistoryClearRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	affectedUsers, err := collectConversationAffectedUsersTx(r.Context(), tx, req.ConversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var maxSeqNo int64
	if err := tx.QueryRow(r.Context(), `SELECT COALESCE(MAX(seq_no), 0) FROM im_message WHERE conversation_id = $1 AND deleted_at IS NULL`, req.ConversationID).Scan(&maxSeqNo); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if _, err := tx.Exec(r.Context(), `
		UPDATE im_conversation
		SET purged_before_seq_no = GREATEST(purged_before_seq_no, $2), updated_at = NOW()
		WHERE id = $1`, req.ConversationID, maxSeqNo); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := refreshConversationSummary(r.Context(), tx, req.ConversationID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "history_cleared", "conversation_title": meta.ConversationTitle}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "cleared_before_seq_no": maxSeqNo})
}

func (a *App) handleSessionMemberHistoryClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req sessionMemberHistoryClearRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	targets := collectRequestedUsernames(req.Username, req.Usernames)
	if len(targets) < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid username"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	affectedUsers, err := collectConversationAffectedUsersTx(r.Context(), tx, req.ConversationID, targets...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var deletedCount int64
	for _, targetUsername := range targets {
		commandTag, execErr := tx.Exec(r.Context(), `
			UPDATE im_message
			SET deleted_at = NOW(), updated_at = NOW()
			WHERE conversation_id = $1
				AND sender_username = $2
				AND deleted_at IS NULL
				AND seq_no > (SELECT COALESCE(purged_before_seq_no, 0) FROM im_conversation WHERE id = $1)`, req.ConversationID, targetUsername)
		if execErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": execErr.Error()})
			return
		}
		deletedCount += commandTag.RowsAffected()
	}
	if err := refreshConversationSummary(r.Context(), tx, req.ConversationID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	payload := map[string]any{"conversation_id": req.ConversationID, "reason": "member_history_cleared", "conversation_title": meta.ConversationTitle, "usernames": targets}
	if len(targets) == 1 {
		payload["sender_username"] = targets[0]
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": payload})
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "deleted_count": deletedCount, "usernames": targets})
}

func (a *App) handleSessionHide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req sessionHideRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	meta, err := a.requireGroupConversationAdmin(r.Context(), req.ConversationID, username)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	affectedUsers, err := collectConversationAffectedUsersTx(r.Context(), tx, req.ConversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE im_conversation SET hidden_for_all = TRUE, updated_at = NOW() WHERE id = $1`, req.ConversationID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "hidden", "conversation_title": meta.ConversationTitle}})
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleInternalGroupProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	var req internalGroupProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	item, err := a.buildConversationGroupProfileItem(r.Context(), req.ConversationID, "", false, true)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) transferConversationOwner(ctx context.Context, conversationID int64, ownerUsername string, transferredBy string) (SessionGroupProfileItem, error) {
	normalizedOwner := strings.ToLower(strings.TrimSpace(ownerUsername))
	if normalizedOwner == "" {
		return SessionGroupProfileItem{}, errors.New("invalid owner_username")
	}
	normalizedTransferredBy := strings.ToLower(strings.TrimSpace(transferredBy))
	if normalizedTransferredBy == "" {
		normalizedTransferredBy = "system"
	}
	meta, err := a.loadConversationMeta(ctx, conversationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SessionGroupProfileItem{}, errors.New("conversation not found")
		}
		return SessionGroupProfileItem{}, err
	}
	if meta.ConversationType != "group" {
		return SessionGroupProfileItem{}, errors.New("conversation not group")
	}
	currentOwner := strings.ToLower(strings.TrimSpace(meta.OwnerUsername))
	if normalizedOwner == currentOwner {
		return a.buildConversationGroupProfileItem(ctx, conversationID, normalizedOwner, false, true)
	}
	if err := a.ensureAllowedConversationOwnerTarget(ctx, normalizedOwner); err != nil {
		return SessionGroupProfileItem{}, err
	}
	updatedConversationKey := meta.ConversationKey
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return SessionGroupProfileItem{}, err
	}
	defer tx.Rollback(ctx)
	affectedUsers, err := collectConversationAffectedUsersTx(ctx, tx, conversationID, currentOwner, normalizedOwner)
	if err != nil {
		return SessionGroupProfileItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE im_conversation
		SET owner_username = $2, conversation_key = $3, updated_at = NOW()
		WHERE id = $1`, conversationID, normalizedOwner, updatedConversationKey); err != nil {
		return SessionGroupProfileItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_conversation_admin (conversation_id, username, assigned_by)
		SELECT $1, $2, $3
		WHERE NOT EXISTS (
			SELECT 1 FROM im_conversation_admin WHERE conversation_id = $1 AND username = $2 AND revoked_at IS NULL
		)`, conversationID, normalizedOwner, normalizedTransferredBy); err != nil {
		return SessionGroupProfileItem{}, err
	}
	if !isWhitelistManagedConversation(meta) {
		activeUsers, err := loadActiveConversationUsernamesTx(ctx, tx, conversationID)
		if err != nil {
			return SessionGroupProfileItem{}, err
		}
		if _, ok := activeUsers[normalizedOwner]; !ok {
			if _, err := tx.Exec(ctx, `
				INSERT INTO im_conversation_member (conversation_id, username, role)
				VALUES ($1, $2, 'member')
				ON CONFLICT DO NOTHING`, conversationID, normalizedOwner); err != nil {
				return SessionGroupProfileItem{}, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return SessionGroupProfileItem{}, err
	}
	updatedMeta := meta
	updatedMeta.OwnerUsername = normalizedOwner
	updatedMeta.ConversationKey = updatedConversationKey
	if isWhitelistManagedConversation(meta) {
		if err := a.syncWhitelistConversationAfterRules(ctx, updatedMeta); err != nil {
			return SessionGroupProfileItem{}, err
		}
	} else {
		affectedUsers[currentOwner] = struct{}{}
		affectedUsers[normalizedOwner] = struct{}{}
		a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID, "reason": "owner_transferred", "owner_username": normalizedOwner, "conversation_title": updatedMeta.ConversationTitle}})
	}
	return a.buildConversationGroupProfileItem(ctx, conversationID, normalizedOwner, false, true)
}

func (a *App) handleInternalGroupOwnerTransfer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	var req internalGroupOwnerTransferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	item, err := a.transferConversationOwner(r.Context(), req.ConversationID, req.OwnerUsername, req.TransferredBy)
	if err != nil {
		writeConversationFeatureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "item": item})
}

func (a *App) handleInternalGroupAdminsReplace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	var req internalGroupAdminsReplaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	meta, err := a.loadConversationMeta(r.Context(), req.ConversationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "conversation not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if meta.ConversationType != "group" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "conversation not group"})
		return
	}
	targets := collectRequestedUsernames(meta.OwnerUsername, req.Usernames)
	for _, target := range targets {
		if err := a.ensureAllowedConversationAdminTarget(r.Context(), meta, target); err != nil {
			writeConversationFeatureError(w, err)
			return
		}
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	oldAdmins, err := loadConversationAdminUsernamesTx(r.Context(), tx, req.ConversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	affectedUsers, err := collectConversationAffectedUsersTx(r.Context(), tx, req.ConversationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	for _, adminUsername := range oldAdmins {
		affectedUsers[adminUsername] = struct{}{}
	}
	for _, target := range targets {
		affectedUsers[target] = struct{}{}
	}
	if _, err := tx.Exec(r.Context(), `
		UPDATE im_conversation_admin
		SET revoked_at = NOW(), updated_at = NOW()
		WHERE conversation_id = $1 AND revoked_at IS NULL`, req.ConversationID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	for _, target := range targets {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO im_conversation_admin (conversation_id, username, assigned_by)
			VALUES ($1, $2, $3)`, req.ConversationID, target, strings.ToLower(strings.TrimSpace(req.AssignedBy))); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	}
	if !isWhitelistManagedConversation(meta) {
		activeUsers, err := loadActiveConversationUsernamesTx(r.Context(), tx, req.ConversationID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		for _, target := range targets {
			if _, ok := activeUsers[target]; ok {
				continue
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO im_conversation_member (conversation_id, username, role)
				VALUES ($1, $2, 'member')
				ON CONFLICT DO NOTHING`, req.ConversationID, target); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
				return
			}
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if isWhitelistManagedConversation(meta) {
		if err := a.syncWhitelistConversationAfterRules(r.Context(), meta); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	} else {
		a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": req.ConversationID, "reason": "admins_replaced"}})
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "admins": targets})
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

func (a *App) loadWhitelistGroupBoundOwnerUsernameTx(ctx context.Context, tx pgx.Tx, adminKey string) (string, error) {
	normalizedAdminKey := strings.ToLower(strings.TrimSpace(adminKey))
	if normalizedAdminKey == "" {
		return "", nil
	}
	var bindingTableName *string
	if err := tx.QueryRow(ctx, `SELECT to_regclass('public.sub_admin_account_bindings')`).Scan(&bindingTableName); err != nil {
		return "", err
	}
	if bindingTableName == nil || strings.TrimSpace(*bindingTableName) == "" {
		return normalizedAdminKey, nil
	}
	var ownerUsername string
	err := tx.QueryRow(ctx, `
		SELECT LOWER(COALESCE(account_username, ''))
		FROM sub_admin_account_bindings
		WHERE LOWER(sub_name) = $1
		LIMIT 1`, normalizedAdminKey).Scan(&ownerUsername)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return normalizedAdminKey, nil
		}
		return "", err
	}
	ownerUsername = strings.ToLower(strings.TrimSpace(ownerUsername))
	if ownerUsername == "" {
		return normalizedAdminKey, nil
	}
	return ownerUsername, nil
}

func (a *App) loadExistingWhitelistGroupKeys(ctx context.Context, addedBy string) ([]string, error) {
	query := `
		SELECT DISTINCT LOWER(COALESCE(conversation_key, '')) AS conversation_key
		FROM im_conversation
		WHERE conversation_type = 'group' AND conversation_key LIKE 'group:admin_whitelist:%'`
	args := make([]any, 0, 1)
	if addedBy != "" {
		query += ` AND LOWER(conversation_key) = $1`
		args = append(args, whitelistGroupKeyPrefix+strings.ToLower(strings.TrimSpace(addedBy)))
	}
	rows, err := a.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0)
	for rows.Next() {
		var conversationKey string
		if err := rows.Scan(&conversationKey); err != nil {
			return nil, err
		}
		adminKey := extractWhitelistGroupAdminKey(conversationKey)
		if adminKey != "" {
			items = append(items, adminKey)
		}
	}
	return normalizeUsernames(items), rows.Err()
}

func (a *App) syncWhitelistGroupByAdmin(ctx context.Context, addedBy string, members []string) error {
	normalizedAdminKey := strings.ToLower(strings.TrimSpace(addedBy))
	if normalizedAdminKey == "" {
		return nil
	}
	whitelistMembers := normalizeUsernames(members)
	conversationKey := whitelistGroupKeyPrefix + normalizedAdminKey
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var conversationID int64
	currentOwner := ""
	conversationLookupErr := tx.QueryRow(ctx, `SELECT id, COALESCE(owner_username, '') FROM im_conversation WHERE conversation_key = $1`, conversationKey).Scan(&conversationID, &currentOwner)
	if conversationLookupErr != nil && !errors.Is(conversationLookupErr, pgx.ErrNoRows) {
		return conversationLookupErr
	}
	currentOwner = strings.ToLower(strings.TrimSpace(currentOwner))
	resolvedOwner, err := a.loadWhitelistGroupBoundOwnerUsernameTx(ctx, tx, normalizedAdminKey)
	if err != nil {
		return err
	}
	affectedUsers := map[string]struct{}{}
	if currentOwner != "" {
		affectedUsers[currentOwner] = struct{}{}
	}
	if resolvedOwner != "" {
		affectedUsers[resolvedOwner] = struct{}{}
	}
	title := whitelistMainGroupTitle
	conversationExists := !errors.Is(conversationLookupErr, pgx.ErrNoRows)
	if !conversationExists && len(whitelistMembers) < 1 {
		return tx.Commit(ctx)
	}
	if !conversationExists {
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_conversation (conversation_type, conversation_key, title, owner_username)
			VALUES ('group', $1, $2, $3)
			ON CONFLICT DO NOTHING`, conversationKey, title, resolvedOwner); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT id FROM im_conversation WHERE conversation_key = $1`, conversationKey).Scan(&conversationID); err != nil {
			return err
		}
	}
	ownerAssignment := whitelistGroupOwnerAssignmentTag(normalizedAdminKey)
	if _, err := tx.Exec(ctx, `
		UPDATE im_conversation_admin
		SET revoked_at = NOW(), updated_at = NOW()
		WHERE conversation_id = $1 AND revoked_at IS NULL AND (
			(assigned_by = $2 AND username <> $3)
			OR ($4 <> '' AND username = $4 AND username <> $3)
		)`, conversationID, ownerAssignment, resolvedOwner, currentOwner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_conversation_admin (conversation_id, username, assigned_by)
		SELECT $1, $2, $3
		WHERE NOT EXISTS (
			SELECT 1 FROM im_conversation_admin WHERE conversation_id = $1 AND username = $2 AND revoked_at IS NULL
		)`, conversationID, resolvedOwner, ownerAssignment); err != nil {
		return err
	}
	adminUsernames, err := loadConversationAdminUsernamesTx(ctx, tx, conversationID)
	if err != nil {
		return err
	}
	overrides, err := loadConversationMemberOverridesTx(ctx, tx, conversationID)
	if err != nil {
		return err
	}
	projectedSet := map[string]struct{}{}
	for _, member := range whitelistMembers {
		projectedSet[member] = struct{}{}
	}
	for _, adminUsername := range adminUsernames {
		projectedSet[adminUsername] = struct{}{}
		affectedUsers[adminUsername] = struct{}{}
	}
	for member, overrideType := range overrides {
		if overrideType == "add" {
			projectedSet[member] = struct{}{}
		}
	}
	for member, overrideType := range overrides {
		if overrideType == "remove" {
			delete(projectedSet, member)
		}
	}
	projectedMembers := make([]string, 0, len(projectedSet))
	for member := range projectedSet {
		projectedMembers = append(projectedMembers, member)
	}
	sort.Strings(projectedMembers)
	if len(projectedMembers) < 1 {
		if !conversationExists {
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
			a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID, "reason": "members_changed"}})
		}
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE im_conversation
		SET conversation_type = 'group', title = $2, owner_username = $3, deleted_at = NULL, updated_at = NOW()
		WHERE id = $1`, conversationID, title, resolvedOwner); err != nil {
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
	for _, member := range projectedMembers {
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
	a.broadcastUsernames(affectedUsers, map[string]any{"type": "im.session.updated", "payload": map[string]any{"conversation_id": conversationID, "reason": "members_changed"}})
	return nil
}

func (a *App) syncWhitelistGroups(ctx context.Context, addedBy string) (int, error) {
	targetOwner := strings.ToLower(strings.TrimSpace(addedBy))
	memberMap, err := a.loadWhitelistGroupMembers(ctx, targetOwner)
	if err != nil {
		return 0, err
	}
	existingOwners, err := a.loadExistingWhitelistGroupKeys(ctx, targetOwner)
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
