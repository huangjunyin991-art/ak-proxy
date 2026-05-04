package taskstore

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	KindImageHEICPreview = "image_heic_preview"

	StatusReserved   = "reserved"
	StatusPending    = "pending"
	StatusProcessing = "processing"
	StatusReady      = "ready"
	StatusFailed     = "failed"

	activeTaskExpireAfter = 30 * time.Minute
)

var ErrActiveTaskExists = errors.New("active media preview task exists")

type Store struct {
	db *pgxpool.Pool
}

type Task struct {
	ID                 int64
	MessageID          int64
	ConversationID     int64
	SenderUsername     string
	MediaKind          string
	SourceStorageName  string
	PreviewStorageName string
	Status             string
	AttemptCount       int
	ErrorMessage       string
	LockedAt           time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
	CompletedAt        time.Time
}

func New(db *pgxpool.Pool) *Store {
	return &Store{db: db}
}

func (s *Store) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_media_preview_task (
			id BIGSERIAL PRIMARY KEY,
			message_id BIGINT REFERENCES im_message(id) ON DELETE CASCADE,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			sender_username TEXT NOT NULL,
			media_kind TEXT NOT NULL DEFAULT 'image_heic_preview',
			source_storage_name TEXT NOT NULL DEFAULT '',
			preview_storage_name TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'reserved',
			attempt_count INTEGER NOT NULL DEFAULT 0,
			error_message TEXT NOT NULL DEFAULT '',
			locked_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			completed_at TIMESTAMP,
			CHECK (media_kind IN ('image_heic_preview')),
			CHECK (status IN ('reserved', 'pending', 'processing', 'ready', 'failed'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_media_preview_task_user_active
			ON im_media_preview_task(sender_username, media_kind)
			WHERE status IN ('reserved', 'pending', 'processing')`,
		`CREATE INDEX IF NOT EXISTS idx_im_media_preview_task_pending
			ON im_media_preview_task(media_kind, status, id)
			WHERE status = 'pending'`,
		`CREATE INDEX IF NOT EXISTS idx_im_media_preview_task_message
			ON im_media_preview_task(message_id)
			WHERE message_id IS NOT NULL`,
	}
	for _, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ReserveImageHEICPreview(ctx context.Context, conversationID int64, username string) (Task, error) {
	if s == nil || s.db == nil {
		return Task{}, errors.New("media task store not initialized")
	}
	normalizedUsername := normalizeUsername(username)
	if conversationID <= 0 || normalizedUsername == "" {
		return Task{}, errors.New("invalid media preview task")
	}
	if err := s.expireStaleActiveTasks(ctx, normalizedUsername); err != nil {
		return Task{}, err
	}
	var task Task
	err = s.db.QueryRow(ctx, `
		INSERT INTO im_media_preview_task (conversation_id, sender_username, media_kind, status)
		VALUES ($1, $2, $3, $4)
		RETURNING id, COALESCE(message_id, 0), conversation_id, sender_username, media_kind, source_storage_name, preview_storage_name, status, attempt_count, error_message, COALESCE(locked_at, 'epoch'::timestamp), created_at, updated_at, COALESCE(completed_at, 'epoch'::timestamp)`,
		conversationID, normalizedUsername, KindImageHEICPreview, StatusReserved,
	).Scan(&task.ID, &task.MessageID, &task.ConversationID, &task.SenderUsername, &task.MediaKind, &task.SourceStorageName, &task.PreviewStorageName, &task.Status, &task.AttemptCount, &task.ErrorMessage, &task.LockedAt, &task.CreatedAt, &task.UpdatedAt, &task.CompletedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return Task{}, ErrActiveTaskExists
		}
		return Task{}, err
	}
	return task, nil
}

func (s *Store) ActivateImageHEICPreview(ctx context.Context, taskID int64, messageID int64, sourceStorageName string) error {
	if s == nil || s.db == nil {
		return errors.New("media task store not initialized")
	}
	if taskID <= 0 || messageID <= 0 || strings.TrimSpace(sourceStorageName) == "" {
		return errors.New("invalid media preview task activation")
	}
	commandTag, err := s.db.Exec(ctx, `
		UPDATE im_media_preview_task
		SET message_id = $1,
			source_storage_name = $2,
			status = $3,
			updated_at = NOW()
		WHERE id = $4 AND status = $5`, messageID, strings.TrimSpace(sourceStorageName), StatusPending, taskID, StatusReserved)
	if err != nil {
		return err
	}
	if commandTag.RowsAffected() <= 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) CancelReservedTask(ctx context.Context, taskID int64) error {
	if s == nil || s.db == nil || taskID <= 0 {
		return nil
	}
	_, err := s.db.Exec(ctx, `DELETE FROM im_media_preview_task WHERE id = $1 AND status = $2`, taskID, StatusReserved)
	return err
}

func (s *Store) ClaimPendingTasks(ctx context.Context, limit int) ([]Task, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("media task store not initialized")
	}
	if limit <= 0 {
		return []Task{}, nil
	}
	rows, err := s.db.Query(ctx, `
		WITH claimed AS (
			SELECT id
			FROM im_media_preview_task
			WHERE media_kind = $1 AND status = $2
			ORDER BY id ASC
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		UPDATE im_media_preview_task t
		SET status = $4,
			attempt_count = attempt_count + 1,
			locked_at = NOW(),
			updated_at = NOW()
		FROM claimed
		WHERE t.id = claimed.id
		RETURNING t.id, COALESCE(t.message_id, 0), t.conversation_id, t.sender_username, t.media_kind, t.source_storage_name, t.preview_storage_name, t.status, t.attempt_count, t.error_message, COALESCE(t.locked_at, 'epoch'::timestamp), t.created_at, t.updated_at, COALESCE(t.completed_at, 'epoch'::timestamp)`,
		KindImageHEICPreview, StatusPending, limit, StatusProcessing)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]Task, 0, limit)
	for rows.Next() {
		var task Task
		if err := rows.Scan(&task.ID, &task.MessageID, &task.ConversationID, &task.SenderUsername, &task.MediaKind, &task.SourceStorageName, &task.PreviewStorageName, &task.Status, &task.AttemptCount, &task.ErrorMessage, &task.LockedAt, &task.CreatedAt, &task.UpdatedAt, &task.CompletedAt); err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *Store) MarkReady(ctx context.Context, taskID int64, previewStorageName string) error {
	if s == nil || s.db == nil || taskID <= 0 {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		UPDATE im_media_preview_task
		SET preview_storage_name = $1,
			status = $2,
			error_message = '',
			updated_at = NOW(),
			completed_at = NOW()
		WHERE id = $3`, strings.TrimSpace(previewStorageName), StatusReady, taskID)
	return err
}

func (s *Store) MarkFailed(ctx context.Context, taskID int64, message string) error {
	if s == nil || s.db == nil || taskID <= 0 {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		UPDATE im_media_preview_task
		SET status = $1,
			error_message = $2,
			updated_at = NOW(),
			completed_at = NOW()
		WHERE id = $3`, StatusFailed, trimErrorMessage(message), taskID)
	return err
}

func (s *Store) activeImageHEICPreviewMessageExists(ctx context.Context, username string) (bool, error) {
	normalizedUsername := normalizeUsername(username)
	if s == nil || s.db == nil || normalizedUsername == "" {
		return false, nil
	}
	var exists bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM im_message
			WHERE sender_username = $1
				AND message_type = 'image'
				AND status = 'normal'
				AND deleted_at IS NULL
				AND content_payload::jsonb ->> 'mime_type' IN ('image/heic', 'image/heif')
				AND content_payload::jsonb ->> 'preview_status' IN ('pending', 'processing')
		)`, normalizedUsername).Scan(&exists)
	return exists, err
}

func (s *Store) expireStaleActiveMessages(ctx context.Context, username string) error {
	normalizedUsername := normalizeUsername(username)
	if s == nil || s.db == nil || normalizedUsername == "" {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		WITH targets AS (
			SELECT id,
				COALESCE(NULLIF(content_payload::jsonb ->> 'original_storage_name', ''), content_payload::jsonb ->> 'storage_name') AS source_storage_name
			FROM im_message
			WHERE sender_username = $1
				AND message_type = 'image'
				AND status = 'normal'
				AND deleted_at IS NULL
				AND content_payload::jsonb ->> 'mime_type' IN ('image/heic', 'image/heif')
				AND content_payload::jsonb ->> 'preview_status' IN ('pending', 'processing')
				AND updated_at < $2
		)
		UPDATE im_message m
		SET content_payload = jsonb_set(
				jsonb_set(
					jsonb_set(m.content_payload::jsonb, '{preview_status}', '"failed"', true),
					'{original_url}', to_jsonb('/im/assets/image/' || targets.source_storage_name), true
				),
				'{file_url}', to_jsonb('/im/assets/image/' || targets.source_storage_name), true
			)::text,
			updated_at = NOW()
		FROM targets
		WHERE m.id = targets.id`, normalizedUsername, time.Now().Add(-activeTaskExpireAfter))
	return err
}

func (s *Store) expireStaleActiveTasks(ctx context.Context, username string) error {
	normalizedUsername := normalizeUsername(username)
	if s == nil || s.db == nil || normalizedUsername == "" {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		WITH expired AS (
			UPDATE im_media_preview_task
			SET status = $1,
				error_message = $2,
				updated_at = NOW(),
				completed_at = NOW()
			WHERE sender_username = $3
				AND media_kind = $4
				AND status IN ($5, $6, $7)
				AND updated_at < $8
			RETURNING message_id, source_storage_name
		)
		UPDATE im_message m
		SET content_payload = jsonb_set(
				jsonb_set(
					jsonb_set(m.content_payload::jsonb, '{preview_status}', '"failed"', true),
					'{original_url}', to_jsonb('/im/assets/image/' || expired.source_storage_name), true
				),
				'{file_url}', to_jsonb('/im/assets/image/' || expired.source_storage_name), true
			)::text,
			updated_at = NOW()
		FROM expired
		WHERE m.id = expired.message_id
			AND m.message_type = 'image'
			AND m.status = 'normal'`,
		StatusFailed,
		"media preview task expired",
		normalizedUsername,
		KindImageHEICPreview,
		StatusReserved,
		StatusPending,
		StatusProcessing,
		time.Now().Add(-activeTaskExpireAfter),
	)
	return err
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func trimErrorMessage(value string) string {
	message := strings.TrimSpace(value)
	if len(message) > 500 {
		return message[:500]
	}
	return message
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
