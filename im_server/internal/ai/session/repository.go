package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"im_server/internal/ai/bot"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

func visibleSessionFilterSQL() string {
	return `
		AND (
			s.conversation_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM im_conversation c
				JOIN im_conversation_member owner_m
				  ON owner_m.conversation_id = c.id
				 AND owner_m.username = s.owner_username
				 AND owner_m.left_at IS NULL
				JOIN im_conversation_member bot_m
				  ON bot_m.conversation_id = c.id
				 AND bot_m.username = '` + bot.Username + `'
				 AND bot_m.left_at IS NULL
				WHERE c.id = s.conversation_id
				  AND c.deleted_at IS NULL
				  AND c.conversation_type = 'direct'
			)
		)`
}

func (r *Repository) EnsureSchema(ctx context.Context) error {
	if r == nil || r.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_session (
			id BIGSERIAL PRIMARY KEY,
			owner_username TEXT NOT NULL,
			conversation_id BIGINT REFERENCES im_conversation(id) ON DELETE SET NULL,
			title TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			pinned BOOLEAN NOT NULL DEFAULT FALSE,
			active_message_id BIGINT NOT NULL DEFAULT 0,
			metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE im_ai_session ADD COLUMN IF NOT EXISTS conversation_id BIGINT REFERENCES im_conversation(id) ON DELETE SET NULL`,
		`ALTER TABLE im_ai_session ADD COLUMN IF NOT EXISTS active_message_id BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_session ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE im_ai_session ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_session_owner_status_updated ON im_ai_session(owner_username, status, pinned DESC, updated_at DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_session_conversation ON im_ai_session(conversation_id) WHERE conversation_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_ai_session_owner_conversation_unique ON im_ai_session(owner_username, conversation_id) WHERE conversation_id IS NOT NULL AND status <> 'deleted'`,
		`CREATE TABLE IF NOT EXISTS im_ai_user_session_state (
			owner_username TEXT PRIMARY KEY,
			active_session_id BIGINT REFERENCES im_ai_session(id) ON DELETE SET NULL,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE im_ai_user_session_state ADD COLUMN IF NOT EXISTS active_session_id BIGINT REFERENCES im_ai_session(id) ON DELETE SET NULL`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_user_session_state_active ON im_ai_user_session_state(active_session_id) WHERE active_session_id IS NOT NULL`,
	}
	for index, stmt := range statements {
		if _, err := r.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("ai session schema statement #%d failed: %w", index+1, err)
		}
	}
	return nil
}

func (r *Repository) EnsureForConversation(ctx context.Context, ownerUsername string, conversationID int64, title string) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" || conversationID <= 0 {
		return Session{}, errors.New("invalid conversation session")
	}
	item, err := r.GetByConversation(ctx, owner, conversationID)
	if err == nil {
		return item, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Session{}, err
	}
	allowed, err := r.isAllowedConversationBinding(ctx, owner, conversationID)
	if err != nil {
		return Session{}, err
	}
	if !allowed {
		return Session{}, errors.New("conversation is not an AI assistant direct chat")
	}
	item, err = r.Create(ctx, CreateInput{
		OwnerUsername:  owner,
		ConversationID: conversationID,
		Title:          title,
		Metadata: map[string]any{
			"source": "legacy_im_ai_conversation",
		},
	})
	if err == nil {
		return item, nil
	}
	// A concurrent request may have created the session after our first lookup.
	if fallback, lookupErr := r.GetByConversation(ctx, owner, conversationID); lookupErr == nil {
		return fallback, nil
	}
	return Session{}, err
}

func (r *Repository) GetByConversation(ctx context.Context, ownerUsername string, conversationID int64) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" || conversationID <= 0 {
		return Session{}, errors.New("invalid conversation session lookup")
	}
	row := r.db.QueryRow(ctx, `
		SELECT id, owner_username, COALESCE(conversation_id, 0), title, status, pinned, active_message_id, metadata_json, created_at, updated_at
		FROM im_ai_session s
		WHERE owner_username = $1 AND conversation_id = $2 AND status <> $3`+visibleSessionFilterSQL()+`
		ORDER BY updated_at DESC, id DESC
		LIMIT 1`, owner, conversationID, StatusDeleted)
	return scanSession(row)
}

func (r *Repository) isAllowedConversationBinding(ctx context.Context, ownerUsername string, conversationID int64) (bool, error) {
	if r == nil || r.db == nil {
		return false, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" || conversationID <= 0 {
		return false, errors.New("invalid conversation binding")
	}
	var exists bool
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM im_conversation c
			JOIN im_conversation_member owner_m
			  ON owner_m.conversation_id = c.id
			 AND owner_m.username = $2
			 AND owner_m.left_at IS NULL
			JOIN im_conversation_member bot_m
			  ON bot_m.conversation_id = c.id
			 AND bot_m.username = $3
			 AND bot_m.left_at IS NULL
			WHERE c.id = $1
			  AND c.deleted_at IS NULL
			  AND c.conversation_type = 'direct'
		)`, conversationID, owner, bot.Username).Scan(&exists)
	return exists, err
}

func (r *Repository) Create(ctx context.Context, input CreateInput) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(input.OwnerUsername)
	if owner == "" {
		return Session{}, errors.New("missing session owner")
	}
	title := normalizeTitle(input.Title)
	if title == "" {
		title = "新对话"
	}
	metadataJSON, err := marshalMetadata(input.Metadata)
	if err != nil {
		return Session{}, err
	}
	var conversationID any
	if input.ConversationID > 0 {
		conversationID = input.ConversationID
	}
	row := r.db.QueryRow(ctx, `
		INSERT INTO im_ai_session (owner_username, conversation_id, title, status, metadata_json, updated_at)
		VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
		RETURNING id, owner_username, COALESCE(conversation_id, 0), title, status, pinned, active_message_id, metadata_json, created_at, updated_at`,
		owner, conversationID, title, StatusActive, metadataJSON)
	return scanSession(row)
}

func (r *Repository) Get(ctx context.Context, ownerUsername string, id int64) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" || id <= 0 {
		return Session{}, errors.New("invalid session lookup")
	}
	row := r.db.QueryRow(ctx, `
		SELECT id, owner_username, COALESCE(conversation_id, 0), title, status, pinned, active_message_id, metadata_json, created_at, updated_at
		FROM im_ai_session s
		WHERE id = $1 AND owner_username = $2 AND status <> $3`+visibleSessionFilterSQL(),
		id, owner, StatusDeleted)
	return scanSession(row)
}

func (r *Repository) List(ctx context.Context, ownerUsername string, includeArchived bool) ([]Session, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" {
		return nil, errors.New("missing session owner")
	}
	statusFilter := `AND status = 'active'`
	if includeArchived {
		statusFilter = `AND status <> 'deleted'`
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, owner_username, COALESCE(conversation_id, 0), title, status, pinned, active_message_id, metadata_json, created_at, updated_at
		FROM im_ai_session s
		WHERE owner_username = $1 `+statusFilter+visibleSessionFilterSQL()+`
		ORDER BY pinned DESC, updated_at DESC, id DESC`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Session, 0)
	for rows.Next() {
		item, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *Repository) Update(ctx context.Context, input UpdateInput) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(input.OwnerUsername)
	if owner == "" || input.ID <= 0 {
		return Session{}, errors.New("invalid session update")
	}
	current, err := r.Get(ctx, owner, input.ID)
	if err != nil {
		return Session{}, err
	}
	if input.Title != nil {
		current.Title = normalizeTitle(*input.Title)
		if current.Title == "" {
			current.Title = "新对话"
		}
	}
	if input.Status != nil {
		current.Status = normalizeStatus(*input.Status)
	}
	if input.Pinned != nil {
		current.Pinned = *input.Pinned
	}
	if input.ActiveMessageID != nil {
		current.ActiveMessageID = *input.ActiveMessageID
		if current.ActiveMessageID < 0 {
			current.ActiveMessageID = 0
		}
	}
	if input.Metadata != nil {
		current.Metadata = input.Metadata
	}
	metadataJSON, err := marshalMetadata(current.Metadata)
	if err != nil {
		return Session{}, err
	}
	row := r.db.QueryRow(ctx, `
		UPDATE im_ai_session
		SET title = $3,
		    status = $4,
		    pinned = $5,
		    active_message_id = $6,
		    metadata_json = $7::jsonb,
		    updated_at = NOW()
		WHERE id = $1 AND owner_username = $2 AND status <> $8
		RETURNING id, owner_username, COALESCE(conversation_id, 0), title, status, pinned, active_message_id, metadata_json, created_at, updated_at`,
		input.ID, owner, current.Title, current.Status, current.Pinned, current.ActiveMessageID, metadataJSON, StatusDeleted)
	return scanSession(row)
}

func (r *Repository) SetActiveMessage(ctx context.Context, ownerUsername string, id int64, activeMessageID int64) (Session, error) {
	return r.Update(ctx, UpdateInput{
		ID:              id,
		OwnerUsername:   ownerUsername,
		ActiveMessageID: &activeMessageID,
	})
}

func (r *Repository) GetActive(ctx context.Context, ownerUsername string) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" {
		return Session{}, errors.New("missing session owner")
	}
	row := r.db.QueryRow(ctx, `
		SELECT s.id, s.owner_username, COALESCE(s.conversation_id, 0), s.title, s.status, s.pinned,
		       s.active_message_id, s.metadata_json, s.created_at, s.updated_at
		FROM im_ai_user_session_state us
		JOIN im_ai_session s ON s.id = us.active_session_id
		WHERE us.owner_username = $1 AND s.owner_username = $1 AND s.status = $2`+visibleSessionFilterSQL()+`
		LIMIT 1`, owner, StatusActive)
	return scanSession(row)
}

func (r *Repository) SetActive(ctx context.Context, ownerUsername string, id int64) (Session, error) {
	if r == nil || r.db == nil {
		return Session{}, errors.New("AI session repository is not available")
	}
	owner := normalizeUsername(ownerUsername)
	if owner == "" || id <= 0 {
		return Session{}, errors.New("invalid active AI session")
	}
	item, err := r.Get(ctx, owner, id)
	if err != nil {
		return Session{}, err
	}
	if item.Status != StatusActive {
		return Session{}, errors.New("only active AI sessions can be selected")
	}
	_, err = r.db.Exec(ctx, `
		INSERT INTO im_ai_user_session_state (owner_username, active_session_id, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (owner_username) DO UPDATE
		SET active_session_id = EXCLUDED.active_session_id,
		    updated_at = NOW()`, owner, item.ID)
	if err != nil {
		return Session{}, err
	}
	return item, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanSession(row scanner) (Session, error) {
	var item Session
	var metadataRaw []byte
	err := row.Scan(
		&item.ID,
		&item.OwnerUsername,
		&item.ConversationID,
		&item.Title,
		&item.Status,
		&item.Pinned,
		&item.ActiveMessageID,
		&metadataRaw,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if err != nil {
		return Session{}, err
	}
	item.Metadata = map[string]any{}
	if len(metadataRaw) > 0 {
		_ = json.Unmarshal(metadataRaw, &item.Metadata)
	}
	return item, nil
}

func marshalMetadata(value map[string]any) (string, error) {
	if value == nil {
		return "{}", nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeTitle(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 80 {
		return string(runes[:80])
	}
	return value
}

func normalizeStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case StatusArchived:
		return StatusArchived
	case StatusDeleted:
		return StatusDeleted
	default:
		return StatusActive
	}
}
