package session_visibility

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type HiddenGroupItem struct {
	ConversationID    int64  `json:"conversation_id"`
	ConversationTitle string `json:"conversation_title"`
	AvatarURL         string `json:"avatar_url,omitempty"`
	OwnerUsername     string `json:"owner_username"`
	MemberCount       int64  `json:"member_count"`
	UpdatedAt         string `json:"updated_at,omitempty"`
}

type VisibilityChangeResult struct {
	Item              HiddenGroupItem
	AffectedUsernames []string
}

type Service struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func (s *Service) ListHiddenGroups(ctx context.Context, owner string) ([]HiddenGroupItem, error) {
	normalizedOwner := normalizeUsername(owner)
	if normalizedOwner == "" || s == nil || s.db == nil {
		return []HiddenGroupItem{}, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT c.id,
		       COALESCE(c.title, ''),
		       COALESCE(c.avatar_url, ''),
		       COALESCE(c.owner_username, ''),
		       COALESCE((
		           SELECT COUNT(*)
		           FROM im_conversation_member cm
		           WHERE cm.conversation_id = c.id AND cm.left_at IS NULL
		       ), 0) AS member_count,
		       c.updated_at
		FROM im_conversation c
		WHERE c.deleted_at IS NULL
		  AND c.conversation_type = 'group'
		  AND COALESCE(c.hidden_for_all, FALSE) = TRUE
		  AND LOWER(COALESCE(c.owner_username, '')) = $1
		ORDER BY c.updated_at DESC, c.id DESC`, normalizedOwner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []HiddenGroupItem{}
	for rows.Next() {
		var item HiddenGroupItem
		var updatedAt time.Time
		if err := rows.Scan(&item.ConversationID, &item.ConversationTitle, &item.AvatarURL, &item.OwnerUsername, &item.MemberCount, &updatedAt); err != nil {
			return nil, err
		}
		item.OwnerUsername = normalizeUsername(item.OwnerUsername)
		item.UpdatedAt = formatTime(updatedAt)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *Service) HideGroup(ctx context.Context, owner string, conversationID int64) (VisibilityChangeResult, error) {
	return s.setHiddenForOwner(ctx, owner, conversationID, true)
}

func (s *Service) RestoreGroup(ctx context.Context, owner string, conversationID int64) (VisibilityChangeResult, error) {
	return s.setHiddenForOwner(ctx, owner, conversationID, false)
}

func (s *Service) setHiddenForOwner(ctx context.Context, owner string, conversationID int64, hidden bool) (VisibilityChangeResult, error) {
	normalizedOwner := normalizeUsername(owner)
	if normalizedOwner == "" || conversationID <= 0 {
		return VisibilityChangeResult{}, errors.New("invalid conversation_id")
	}
	if s == nil || s.db == nil {
		return VisibilityChangeResult{}, errors.New("session visibility service unavailable")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return VisibilityChangeResult{}, err
	}
	defer tx.Rollback(ctx)
	item, err := s.loadOwnedGroupForUpdate(ctx, tx, normalizedOwner, conversationID)
	if err != nil {
		return VisibilityChangeResult{}, err
	}
	affectedUsernames, err := s.loadActiveMemberUsernames(ctx, tx, conversationID, normalizedOwner)
	if err != nil {
		return VisibilityChangeResult{}, err
	}
	var updatedAt time.Time
	if err := tx.QueryRow(ctx, `
		UPDATE im_conversation
		SET hidden_for_all = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING updated_at`, conversationID, hidden).Scan(&updatedAt); err != nil {
		return VisibilityChangeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VisibilityChangeResult{}, err
	}
	item.UpdatedAt = formatTime(updatedAt)
	return VisibilityChangeResult{Item: item, AffectedUsernames: affectedUsernames}, nil
}

func (s *Service) loadOwnedGroupForUpdate(ctx context.Context, tx pgx.Tx, owner string, conversationID int64) (HiddenGroupItem, error) {
	var item HiddenGroupItem
	var updatedAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT c.id,
		       COALESCE(c.title, ''),
		       COALESCE(c.avatar_url, ''),
		       COALESCE(c.owner_username, ''),
		       COALESCE((
		           SELECT COUNT(*)
		           FROM im_conversation_member cm
		           WHERE cm.conversation_id = c.id AND cm.left_at IS NULL
		       ), 0) AS member_count,
		       c.updated_at
		FROM im_conversation c
		WHERE c.id = $1
		  AND c.deleted_at IS NULL
		  AND c.conversation_type = 'group'
		FOR UPDATE`, conversationID).Scan(&item.ConversationID, &item.ConversationTitle, &item.AvatarURL, &item.OwnerUsername, &item.MemberCount, &updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return HiddenGroupItem{}, errors.New("conversation not found")
		}
		return HiddenGroupItem{}, err
	}
	item.OwnerUsername = normalizeUsername(item.OwnerUsername)
	item.UpdatedAt = formatTime(updatedAt)
	if item.OwnerUsername != owner {
		return HiddenGroupItem{}, errors.New("forbidden")
	}
	return item, nil
}

func (s *Service) loadActiveMemberUsernames(ctx context.Context, tx pgx.Tx, conversationID int64, extras ...string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT username
		FROM im_conversation_member
		WHERE conversation_id = $1 AND left_at IS NULL`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]struct{}{}
	items := []string{}
	appendUsername := func(value string) {
		normalized := normalizeUsername(value)
		if normalized == "" {
			return
		}
		if _, ok := seen[normalized]; ok {
			return
		}
		seen[normalized] = struct{}{}
		items = append(items, normalized)
	}
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		appendUsername(username)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range extras {
		appendUsername(item)
	}
	return items, nil
}
