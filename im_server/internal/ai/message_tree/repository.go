package messagetree

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

func (r *Repository) EnsureSchema(ctx context.Context) error {
	if r == nil || r.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_message (
			id BIGSERIAL PRIMARY KEY,
			session_id BIGINT NOT NULL REFERENCES im_ai_session(id) ON DELETE CASCADE,
			parent_id BIGINT REFERENCES im_ai_message(id) ON DELETE SET NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL DEFAULT '',
			version_group_id TEXT NOT NULL DEFAULT '',
			version_no INTEGER NOT NULL DEFAULT 1,
			source_message_id BIGINT NOT NULL DEFAULT 0,
			projection_message_id BIGINT NOT NULL DEFAULT 0,
			provider_id BIGINT NOT NULL DEFAULT 0,
			model TEXT NOT NULL DEFAULT '',
			finish_reason TEXT NOT NULL DEFAULT '',
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS source_message_id BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS projection_message_id BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS provider_id BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS finish_reason TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS completion_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS total_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_ai_message ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_ai_message_version_unique ON im_ai_message(session_id, version_group_id, version_no) WHERE version_group_id <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_message_session_parent ON im_ai_message(session_id, parent_id, id)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_message_session_created ON im_ai_message(session_id, created_at DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_message_source ON im_ai_message(session_id, source_message_id, role) WHERE source_message_id > 0`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_message_projection ON im_ai_message(projection_message_id) WHERE projection_message_id > 0`,
		`CREATE TABLE IF NOT EXISTS im_ai_message_projection (
			ai_message_id BIGINT PRIMARY KEY REFERENCES im_ai_message(id) ON DELETE CASCADE,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			message_id BIGINT NOT NULL REFERENCES im_message(id) ON DELETE CASCADE,
			visible BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			UNIQUE(message_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_message_projection_conversation ON im_ai_message_projection(conversation_id, message_id)`,
	}
	for index, stmt := range statements {
		if _, err := r.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("ai message tree schema statement #%d failed: %w", index+1, err)
		}
	}
	return nil
}

func (r *Repository) Append(ctx context.Context, input AppendInput) (Message, error) {
	if r == nil || r.db == nil {
		return Message{}, errors.New("AI message tree repository is not available")
	}
	if input.SessionID <= 0 {
		return Message{}, errors.New("missing AI session")
	}
	role := normalizeRole(input.Role)
	if role == "" {
		return Message{}, errors.New("invalid AI message role")
	}
	if strings.TrimSpace(input.Content) == "" {
		return Message{}, errors.New("missing AI message content")
	}
	versionGroupID := strings.TrimSpace(input.VersionGroupID)
	if versionGroupID == "" {
		generated, err := newVersionGroupID()
		if err != nil {
			return Message{}, err
		}
		versionGroupID = generated
	}
	versionNo := input.VersionNo
	if versionNo <= 0 {
		next, err := r.nextVersionNo(ctx, input.SessionID, versionGroupID)
		if err != nil {
			return Message{}, err
		}
		versionNo = next
	}
	metadataJSON, err := marshalMetadata(input.Metadata)
	if err != nil {
		return Message{}, err
	}
	var parentID any
	if input.ParentID > 0 {
		parentID = input.ParentID
	}
	row := r.db.QueryRow(ctx, `
		INSERT INTO im_ai_message (
			session_id, parent_id, role, content, version_group_id, version_no,
			source_message_id, projection_message_id, provider_id, model, finish_reason,
			prompt_tokens, completion_tokens, total_tokens, metadata_json, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, NOW())
		RETURNING id, session_id, COALESCE(parent_id, 0), role, content, version_group_id, version_no,
		          source_message_id, projection_message_id, provider_id, model, finish_reason,
		          prompt_tokens, completion_tokens, total_tokens, metadata_json, created_at, updated_at`,
		input.SessionID, parentID, role, input.Content, versionGroupID, versionNo,
		positive(input.SourceMessageID), positive(input.ProjectionMessageID), positive(input.ProviderID),
		strings.TrimSpace(input.Model), strings.TrimSpace(input.FinishReason),
		nonNegative(input.PromptTokens), nonNegative(input.CompletionTokens), nonNegative(input.TotalTokens), metadataJSON)
	return scanMessage(row)
}

func (r *Repository) List(ctx context.Context, sessionID int64) ([]Message, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("AI message tree repository is not available")
	}
	if sessionID <= 0 {
		return nil, errors.New("missing AI session")
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, session_id, COALESCE(parent_id, 0), role, content, version_group_id, version_no,
		       source_message_id, projection_message_id, provider_id, model, finish_reason,
		       prompt_tokens, completion_tokens, total_tokens, metadata_json, created_at, updated_at
		FROM im_ai_message
		WHERE session_id = $1
		ORDER BY id ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Message, 0)
	for rows.Next() {
		item, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *Repository) FindBySourceMessage(ctx context.Context, sessionID int64, sourceMessageID int64, role string) (Message, error) {
	if r == nil || r.db == nil {
		return Message{}, errors.New("AI message tree repository is not available")
	}
	if sessionID <= 0 || sourceMessageID <= 0 {
		return Message{}, errors.New("invalid AI source message lookup")
	}
	normalizedRole := normalizeRole(role)
	if normalizedRole == "" {
		return Message{}, errors.New("invalid AI message role")
	}
	row := r.db.QueryRow(ctx, `
		SELECT id, session_id, COALESCE(parent_id, 0), role, content, version_group_id, version_no,
		       source_message_id, projection_message_id, provider_id, model, finish_reason,
		       prompt_tokens, completion_tokens, total_tokens, metadata_json, created_at, updated_at
		FROM im_ai_message
		WHERE session_id = $1 AND source_message_id = $2 AND role = $3
		ORDER BY id DESC
		LIMIT 1`, sessionID, sourceMessageID, normalizedRole)
	return scanMessage(row)
}

func (r *Repository) FindByProjectionMessage(ctx context.Context, projectionMessageID int64) (Message, error) {
	if r == nil || r.db == nil {
		return Message{}, errors.New("AI message tree repository is not available")
	}
	if projectionMessageID <= 0 {
		return Message{}, errors.New("invalid AI projection message lookup")
	}
	row := r.db.QueryRow(ctx, `
		SELECT id, session_id, COALESCE(parent_id, 0), role, content, version_group_id, version_no,
		       source_message_id, projection_message_id, provider_id, model, finish_reason,
		       prompt_tokens, completion_tokens, total_tokens, metadata_json, created_at, updated_at
		FROM im_ai_message
		WHERE projection_message_id = $1
		ORDER BY id DESC
		LIMIT 1`, projectionMessageID)
	return scanMessage(row)
}

func (r *Repository) ActivePath(ctx context.Context, sessionID int64, leafID int64) ([]Message, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("AI message tree repository is not available")
	}
	if sessionID <= 0 || leafID <= 0 {
		return nil, errors.New("invalid active path")
	}
	rows, err := r.db.Query(ctx, `
		WITH RECURSIVE path AS (
			SELECT m.*, 0 AS depth
			FROM im_ai_message m
			WHERE m.session_id = $1 AND m.id = $2
			UNION ALL
			SELECT parent.*, path.depth + 1 AS depth
			FROM im_ai_message parent
			JOIN path ON path.parent_id = parent.id
			WHERE parent.session_id = $1
		)
		SELECT id, session_id, COALESCE(parent_id, 0), role, content, version_group_id, version_no,
		       source_message_id, projection_message_id, provider_id, model, finish_reason,
		       prompt_tokens, completion_tokens, total_tokens, metadata_json, created_at, updated_at
		FROM path
		ORDER BY depth DESC`, sessionID, leafID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Message, 0)
	for rows.Next() {
		item, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, pgx.ErrNoRows
	}
	return items, nil
}

func (r *Repository) SetProjection(ctx context.Context, input ProjectionInput) error {
	if r == nil || r.db == nil {
		return errors.New("AI message tree repository is not available")
	}
	if input.AIMessageID <= 0 || input.ConversationID <= 0 || input.MessageID <= 0 {
		return errors.New("invalid AI message projection")
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO im_ai_message_projection (ai_message_id, conversation_id, message_id, visible, updated_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (ai_message_id) DO UPDATE
		SET conversation_id = EXCLUDED.conversation_id,
		    message_id = EXCLUDED.message_id,
		    visible = EXCLUDED.visible,
		    updated_at = NOW()`,
		input.AIMessageID, input.ConversationID, input.MessageID, input.Visible)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `
		UPDATE im_ai_message
		SET projection_message_id = $2, updated_at = NOW()
		WHERE id = $1`, input.AIMessageID, input.MessageID)
	return err
}

func (r *Repository) nextVersionNo(ctx context.Context, sessionID int64, versionGroupID string) (int, error) {
	next := 1
	err := r.db.QueryRow(ctx, `
		SELECT COALESCE(MAX(version_no), 0) + 1
		FROM im_ai_message
		WHERE session_id = $1 AND version_group_id = $2`, sessionID, versionGroupID).Scan(&next)
	return next, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanMessage(row scanner) (Message, error) {
	var item Message
	var metadataRaw []byte
	err := row.Scan(
		&item.ID,
		&item.SessionID,
		&item.ParentID,
		&item.Role,
		&item.Content,
		&item.VersionGroupID,
		&item.VersionNo,
		&item.SourceMessageID,
		&item.ProjectionMessageID,
		&item.ProviderID,
		&item.Model,
		&item.FinishReason,
		&item.PromptTokens,
		&item.CompletionTokens,
		&item.TotalTokens,
		&metadataRaw,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if err != nil {
		return Message{}, err
	}
	item.Metadata = map[string]any{}
	if len(metadataRaw) > 0 {
		_ = json.Unmarshal(metadataRaw, &item.Metadata)
	}
	return item, nil
}

func normalizeRole(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case RoleSystem:
		return RoleSystem
	case RoleUser:
		return RoleUser
	case RoleAssistant:
		return RoleAssistant
	case RoleTool:
		return RoleTool
	default:
		return ""
	}
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

func newVersionGroupID() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "aimg_" + hex.EncodeToString(buf), nil
}

func positive(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func nonNegative(value int) int {
	if value < 0 {
		return 0
	}
	return value
}
