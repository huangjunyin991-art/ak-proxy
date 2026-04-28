package social

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db *pgxpool.Pool
	identityResolver IdentityResolver
}

type IdentityResolver func(ctx context.Context, usernames []string) (map[string]IdentityItem, error)

func New(db *pgxpool.Pool, identityResolver IdentityResolver) *Service {
	return &Service{db: db, identityResolver: identityResolver}
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_user_contact (
			id BIGSERIAL PRIMARY KEY,
			owner_username TEXT NOT NULL,
			target_username TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual_add',
			status TEXT NOT NULL DEFAULT 'active',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS im_user_blacklist (
			id BIGSERIAL PRIMARY KEY,
			owner_username TEXT NOT NULL,
			target_username TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS im_direct_message_gate (
			conversation_id BIGINT PRIMARY KEY REFERENCES im_conversation(id) ON DELETE CASCADE,
			initiator_username TEXT NOT NULL,
			first_message_id BIGINT NOT NULL DEFAULT 0,
			first_message_sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
			reply_unlocked_at TIMESTAMP,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE im_user_contact ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual_add'`,
		`ALTER TABLE im_user_contact ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
		`ALTER TABLE im_user_contact ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
		`ALTER TABLE im_user_contact ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
		`ALTER TABLE im_user_blacklist ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
		`ALTER TABLE im_user_blacklist ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
		`ALTER TABLE im_direct_message_gate ADD COLUMN IF NOT EXISTS first_message_id BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE im_direct_message_gate ADD COLUMN IF NOT EXISTS first_message_sent_at TIMESTAMP NOT NULL DEFAULT NOW()`,
		`ALTER TABLE im_direct_message_gate ADD COLUMN IF NOT EXISTS reply_unlocked_at TIMESTAMP`,
		`ALTER TABLE im_direct_message_gate ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
		`CREATE INDEX IF NOT EXISTS idx_im_user_contact_owner ON im_user_contact(owner_username, updated_at DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_user_blacklist_owner ON im_user_blacklist(owner_username, updated_at DESC, id DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_user_contact_active_unique ON im_user_contact(owner_username, target_username) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_user_blacklist_active_unique ON im_user_blacklist(owner_username, target_username) WHERE deleted_at IS NULL`,
	}
	for index, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("social ensure schema statement #%d failed: %w", index+1, err)
		}
	}
	return nil
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeUsernames(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized := normalizeUsername(value)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func sortContactItems(items []ContactItem) {
	sort.SliceStable(items, func(left int, right int) bool {
		leftName := strings.TrimSpace(items[left].DisplayName)
		rightName := strings.TrimSpace(items[right].DisplayName)
		if leftName == rightName {
			return items[left].Username < items[right].Username
		}
		return leftName < rightName
	})
}

func (s *Service) buildIdentityItems(ctx context.Context, usernames []string) (map[string]IdentityItem, error) {
	normalizedUsernames := normalizeUsernames(usernames)
	result := map[string]IdentityItem{}
	if s == nil || s.db == nil || len(normalizedUsernames) == 0 {
		return result, nil
	}
	if s.identityResolver != nil {
		resolved, err := s.identityResolver(ctx, normalizedUsernames)
		if err != nil {
			return nil, err
		}
		for _, username := range normalizedUsernames {
			item, ok := resolved[username]
			if !ok {
				result[username] = IdentityItem{Username: username, DisplayName: username}
				continue
			}
			item.Username = normalizeUsername(item.Username)
			if item.Username == "" {
				item.Username = username
			}
			item.DisplayName = strings.TrimSpace(item.DisplayName)
			if item.DisplayName == "" {
				item.DisplayName = item.Username
			}
			item.HonorName = strings.TrimSpace(item.HonorName)
			item.AvatarURL = strings.TrimSpace(item.AvatarURL)
			result[username] = item
		}
		return result, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT input.username,
			COALESCE(NULLIF(p.nickname, ''), NULLIF(us.real_name, ''), input.username) AS display_name,
			COALESCE(ua.honor_name, '') AS honor_name,
			COALESCE(p.avatar_url, '') AS avatar_url
		FROM unnest($1::text[]) AS input(username)
		LEFT JOIN im_user_profile p ON p.username = input.username
		LEFT JOIN user_stats us ON us.username = input.username
		LEFT JOIN user_assets ua ON ua.username = input.username`, normalizedUsernames)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item IdentityItem
		if err := rows.Scan(&item.Username, &item.DisplayName, &item.HonorName, &item.AvatarURL); err != nil {
			return nil, err
		}
		item.Username = normalizeUsername(item.Username)
		item.DisplayName = strings.TrimSpace(item.DisplayName)
		if item.DisplayName == "" {
			item.DisplayName = item.Username
		}
		item.HonorName = strings.TrimSpace(item.HonorName)
		item.AvatarURL = strings.TrimSpace(item.AvatarURL)
		result[item.Username] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, username := range normalizedUsernames {
		if _, ok := result[username]; ok {
			continue
		}
		result[username] = IdentityItem{Username: username, DisplayName: username}
	}
	return result, nil
}

func (s *Service) buildContactItems(ctx context.Context, usernames []string, source string, isContact bool, blacklistSet map[string]struct{}) ([]ContactItem, error) {
	normalizedUsernames := normalizeUsernames(usernames)
	identities, err := s.buildIdentityItems(ctx, normalizedUsernames)
	if err != nil {
		return nil, err
	}
	items := make([]ContactItem, 0, len(normalizedUsernames))
	for _, username := range normalizedUsernames {
		if _, blocked := blacklistSet[username]; blocked {
			continue
		}
		identity := identities[username]
		items = append(items, ContactItem{
			Username:    username,
			DisplayName: identity.DisplayName,
			HonorName:   identity.HonorName,
			AvatarURL:   identity.AvatarURL,
			Source:      source,
			IsContact:   isContact,
		})
	}
	sortContactItems(items)
	return items, nil
}

func (s *Service) existsAllowedUser(ctx context.Context, username string) (bool, error) {
	normalizedUsername := normalizeUsername(username)
	if normalizedUsername == "" || s == nil || s.db == nil {
		return false, nil
	}
	var exists bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM user_stats us
			JOIN authorized_accounts aa ON aa.username = us.username
			WHERE us.username = $1
			  AND aa.status = 'active'
			  AND aa.expire_time > NOW()
		)`, normalizedUsername).Scan(&exists)
	return exists, err
}

func (s *Service) listActiveBlacklistSet(ctx context.Context, owner string) (map[string]struct{}, []string, error) {
	normalizedOwner := normalizeUsername(owner)
	resultSet := map[string]struct{}{}
	resultList := []string{}
	if normalizedOwner == "" || s == nil || s.db == nil {
		return resultSet, resultList, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT target_username
		FROM im_user_blacklist
		WHERE owner_username = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC, id DESC`, normalizedOwner)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, nil, err
		}
		normalizedUsername := normalizeUsername(username)
		if normalizedUsername == "" {
			continue
		}
		if _, ok := resultSet[normalizedUsername]; ok {
			continue
		}
		resultSet[normalizedUsername] = struct{}{}
		resultList = append(resultList, normalizedUsername)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return resultSet, resultList, nil
}

func (s *Service) listManualContactUsernames(ctx context.Context, owner string) ([]string, error) {
	normalizedOwner := normalizeUsername(owner)
	if normalizedOwner == "" || s == nil || s.db == nil {
		return []string{}, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT target_username
		FROM im_user_contact
		WHERE owner_username = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC, id DESC`, normalizedOwner)
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

func (s *Service) listWhitelistContactUsernames(ctx context.Context, owner string) ([]string, error) {
	normalizedOwner := normalizeUsername(owner)
	if normalizedOwner == "" || s == nil || s.db == nil {
		return []string{}, nil
	}
	var conversationID int64
	err := s.db.QueryRow(ctx, `
		SELECT c.id
		FROM im_conversation c
		JOIN im_conversation_member cm ON cm.conversation_id = c.id AND cm.username = $1 AND cm.left_at IS NULL
		WHERE c.deleted_at IS NULL
		  AND c.conversation_type = 'group'
		  AND c.conversation_key LIKE $2
		ORDER BY c.id ASC
		LIMIT 1`, normalizedOwner, "group:admin_whitelist:%").Scan(&conversationID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return []string{}, nil
		}
		return nil, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT username
		FROM im_conversation_member
		WHERE conversation_id = $1 AND left_at IS NULL AND username <> $2
		ORDER BY username ASC`, conversationID, normalizedOwner)
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

func (s *Service) ListContacts(ctx context.Context, owner string) (ContactsResult, error) {
	normalizedOwner := normalizeUsername(owner)
	result := ContactsResult{Items: []ContactItem{}, Sections: []ContactSection{}}
	if normalizedOwner == "" {
		return result, nil
	}
	blacklistSet, _, err := s.listActiveBlacklistSet(ctx, normalizedOwner)
	if err != nil {
		return result, err
	}
	manualUsernames, err := s.listManualContactUsernames(ctx, normalizedOwner)
	if err != nil {
		return result, err
	}
	manualItems, err := s.buildContactItems(ctx, manualUsernames, ContactSourceManual, true, blacklistSet)
	if err != nil {
		return result, err
	}
	manualSeen := map[string]struct{}{}
	for _, item := range manualItems {
		manualSeen[item.Username] = struct{}{}
	}
	whitelistUsernames, err := s.listWhitelistContactUsernames(ctx, normalizedOwner)
	if err != nil {
		return result, err
	}
	filteredWhitelist := make([]string, 0, len(whitelistUsernames))
	for _, username := range whitelistUsernames {
		if _, ok := manualSeen[username]; ok {
			continue
		}
		filteredWhitelist = append(filteredWhitelist, username)
	}
	whitelistItems, err := s.buildContactItems(ctx, filteredWhitelist, ContactSourceWhitelist, true, blacklistSet)
	if err != nil {
		return result, err
	}
	if len(manualItems) > 0 {
		result.Sections = append(result.Sections, ContactSection{Key: ContactSourceManual, Title: "我的联系人", Items: manualItems})
	}
	if len(whitelistItems) > 0 {
		result.Sections = append(result.Sections, ContactSection{Key: ContactSourceWhitelist, Title: "白名单联系人", Items: whitelistItems})
	}
	result.Items = append(result.Items, manualItems...)
	result.Items = append(result.Items, whitelistItems...)
	return result, nil
}

func (s *Service) SearchUsers(ctx context.Context, owner string, keyword string, limit int) ([]ContactItem, error) {
	normalizedOwner := normalizeUsername(owner)
	normalizedKeyword := strings.TrimSpace(keyword)
	if normalizedOwner == "" || normalizedKeyword == "" || s == nil || s.db == nil {
		return []ContactItem{}, nil
	}
	if limit <= 0 || limit > 30 {
		limit = 20
	}
	blacklistSet, _, err := s.listActiveBlacklistSet(ctx, normalizedOwner)
	if err != nil {
		return nil, err
	}
	manualUsernames, err := s.listManualContactUsernames(ctx, normalizedOwner)
	if err != nil {
		return nil, err
	}
	contactSet := map[string]string{}
	for _, username := range manualUsernames {
		contactSet[username] = ContactSourceManual
	}
	whitelistUsernames, err := s.listWhitelistContactUsernames(ctx, normalizedOwner)
	if err != nil {
		return nil, err
	}
	for _, username := range whitelistUsernames {
		if _, exists := contactSet[username]; exists {
			continue
		}
		contactSet[username] = ContactSourceWhitelist
	}
	likeValue := "%" + normalizedKeyword + "%"
	rows, err := s.db.Query(ctx, `
		SELECT ua.username
		FROM user_assets ua
		JOIN authorized_accounts aa ON aa.username = ua.username AND aa.status = 'active' AND aa.expire_time > NOW()
		LEFT JOIN user_stats us ON us.username = ua.username
		WHERE ua.username <> $1
		  AND (ua.username ILIKE $2 OR COALESCE(NULLIF(us.real_name, ''), '') ILIKE $2)
		ORDER BY CASE WHEN ua.username = $3 THEN 0 WHEN ua.username ILIKE $2 THEN 1 ELSE 2 END,
			COALESCE(NULLIF(us.real_name, ''), ua.username) ASC,
			ua.username ASC
		LIMIT $4`, normalizedOwner, likeValue, strings.ToLower(normalizedKeyword), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	usernames := make([]string, 0, limit)
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		normalizedUsername := normalizeUsername(username)
		if normalizedUsername == "" {
			continue
		}
		if _, blocked := blacklistSet[normalizedUsername]; blocked {
			continue
		}
		if _, exists := contactSet[normalizedUsername]; exists {
			continue
		}
		usernames = append(usernames, normalizedUsername)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	usernames = normalizeUsernames(usernames)
	identities, err := s.buildIdentityItems(ctx, usernames)
	if err != nil {
		return nil, err
	}
	items := make([]ContactItem, 0, len(usernames))
	for _, username := range usernames {
		identity := identities[username]
		item := ContactItem{
			Username:    username,
			DisplayName: identity.DisplayName,
			HonorName:   identity.HonorName,
			AvatarURL:   identity.AvatarURL,
			Source:      "",
			IsContact:   false,
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) AddContact(ctx context.Context, owner string, target string) (ContactItem, error) {
	normalizedOwner := normalizeUsername(owner)
	normalizedTarget := normalizeUsername(target)
	if normalizedOwner == "" || normalizedTarget == "" || normalizedOwner == normalizedTarget {
		return ContactItem{}, fmt.Errorf("invalid target username")
	}
	exists, err := s.existsAllowedUser(ctx, normalizedTarget)
	if err != nil {
		return ContactItem{}, err
	}
	if !exists {
		return ContactItem{}, fmt.Errorf("target user not allowed")
	}
	blacklistSet, _, err := s.listActiveBlacklistSet(ctx, normalizedOwner)
	if err != nil {
		return ContactItem{}, err
	}
	if _, blocked := blacklistSet[normalizedTarget]; blocked {
		return ContactItem{}, fmt.Errorf("该用户已在黑名单中，请先移出黑名单")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return ContactItem{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		WITH revive AS (
			SELECT id FROM im_user_contact
			WHERE owner_username = $1 AND target_username = $2 AND deleted_at IS NOT NULL
			ORDER BY updated_at DESC, id DESC
			LIMIT 1
		)
		UPDATE im_user_contact
		SET deleted_at = NULL, status = 'active', source = 'manual_add', updated_at = NOW()
		WHERE id IN (SELECT id FROM revive)`, normalizedOwner, normalizedTarget); err != nil {
		return ContactItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_user_contact (owner_username, target_username, source, status, created_at, updated_at)
		SELECT $1, $2, 'manual_add', 'active', NOW(), NOW()
		WHERE NOT EXISTS (
			SELECT 1 FROM im_user_contact WHERE owner_username = $1 AND target_username = $2 AND deleted_at IS NULL
		)`, normalizedOwner, normalizedTarget); err != nil {
		return ContactItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ContactItem{}, err
	}
	items, err := s.buildContactItems(ctx, []string{normalizedTarget}, ContactSourceManual, true, map[string]struct{}{})
	if err != nil {
		return ContactItem{}, err
	}
	if len(items) == 0 {
		return ContactItem{Username: normalizedTarget, DisplayName: normalizedTarget, Source: ContactSourceManual, IsContact: true}, nil
	}
	return items[0], nil
}

func (s *Service) ListBlacklist(ctx context.Context, owner string) ([]ContactItem, error) {
	normalizedOwner := normalizeUsername(owner)
	if normalizedOwner == "" {
		return []ContactItem{}, nil
	}
	_, usernames, err := s.listActiveBlacklistSet(ctx, normalizedOwner)
	if err != nil {
		return nil, err
	}
	items, err := s.buildContactItems(ctx, usernames, "blacklist", false, map[string]struct{}{})
	if err != nil {
		return nil, err
	}
	for index := range items {
		items[index].IsBlacklisted = true
	}
	return items, nil
}

func (s *Service) AddToBlacklist(ctx context.Context, owner string, target string) (ContactItem, error) {
	normalizedOwner := normalizeUsername(owner)
	normalizedTarget := normalizeUsername(target)
	if normalizedOwner == "" || normalizedTarget == "" || normalizedOwner == normalizedTarget {
		return ContactItem{}, fmt.Errorf("invalid target username")
	}
	exists, err := s.existsAllowedUser(ctx, normalizedTarget)
	if err != nil {
		return ContactItem{}, err
	}
	if !exists {
		return ContactItem{}, fmt.Errorf("target user not allowed")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return ContactItem{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		WITH revive AS (
			SELECT id FROM im_user_blacklist
			WHERE owner_username = $1 AND target_username = $2 AND deleted_at IS NOT NULL
			ORDER BY updated_at DESC, id DESC
			LIMIT 1
		)
		UPDATE im_user_blacklist
		SET deleted_at = NULL, updated_at = NOW()
		WHERE id IN (SELECT id FROM revive)`, normalizedOwner, normalizedTarget); err != nil {
		return ContactItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_user_blacklist (owner_username, target_username, created_at, updated_at)
		SELECT $1, $2, NOW(), NOW()
		WHERE NOT EXISTS (
			SELECT 1 FROM im_user_blacklist WHERE owner_username = $1 AND target_username = $2 AND deleted_at IS NULL
		)`, normalizedOwner, normalizedTarget); err != nil {
		return ContactItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ContactItem{}, err
	}
	items, err := s.buildContactItems(ctx, []string{normalizedTarget}, "blacklist", false, map[string]struct{}{})
	if err != nil {
		return ContactItem{}, err
	}
	if len(items) == 0 {
		return ContactItem{Username: normalizedTarget, DisplayName: normalizedTarget, Source: "blacklist", IsBlacklisted: true}, nil
	}
	items[0].IsBlacklisted = true
	return items[0], nil
}

func (s *Service) RemoveFromBlacklist(ctx context.Context, owner string, target string) error {
	normalizedOwner := normalizeUsername(owner)
	normalizedTarget := normalizeUsername(target)
	if normalizedOwner == "" || normalizedTarget == "" {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		UPDATE im_user_blacklist
		SET deleted_at = NOW(), updated_at = NOW()
		WHERE owner_username = $1 AND target_username = $2 AND deleted_at IS NULL`, normalizedOwner, normalizedTarget)
	return err
}
