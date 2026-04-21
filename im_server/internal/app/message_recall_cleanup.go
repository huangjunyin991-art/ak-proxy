package app

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	messageRecallEditableWindow     = time.Minute
	recalledTextCleanupBatchSize    = 32
	recalledTextCleanupInterval     = 5 * time.Second
)

type recallCleanupPlan struct {
	ImageStorageName string
	VoiceStorageName string
	FileStorageName  string
}

func buildRecallCleanupPlan(item MessageItem) (recallCleanupPlan, error) {
	switch strings.ToLower(strings.TrimSpace(item.MessageType)) {
	case "image":
		payload, err := normalizeImageMessagePayload(item.Content)
		if err != nil {
			return recallCleanupPlan{}, err
		}
		return recallCleanupPlan{ImageStorageName: payload.StorageName}, nil
	case "voice":
		payload, err := normalizeVoiceMessagePayload(item.Content)
		if err != nil {
			return recallCleanupPlan{}, err
		}
		return recallCleanupPlan{VoiceStorageName: payload.StorageName}, nil
	case "file":
		payload, err := normalizeStoredFileMessagePayload(item.Content)
		if err != nil {
			return recallCleanupPlan{}, err
		}
		return recallCleanupPlan{FileStorageName: payload.StorageName}, nil
	default:
		return recallCleanupPlan{}, nil
	}
}

func buildDeletedMessageItem(item MessageItem, sentAt time.Time) MessageItem {
	item.Content = ""
	item.ContentPreview = ""
	item.Status = "deleted"
	item.ClientTempID = ""
	item.ReadProgress = nil
	item.SentAt = sentAt.Format(time.RFC3339)
	return item
}

func (a *App) syncConversationLastMessageTx(ctx context.Context, tx pgx.Tx, conversationID int64) error {
	var lastMessageID int64
	var lastMessagePreview string
	var lastMessageAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT id, content_preview, sent_at
		FROM im_message
		WHERE conversation_id = $1 AND deleted_at IS NULL
		ORDER BY seq_no DESC
		LIMIT 1`, conversationID,
	).Scan(&lastMessageID, &lastMessagePreview, &lastMessageAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_, updateErr := tx.Exec(ctx, `
				UPDATE im_conversation
				SET last_message_id = NULL,
					last_message_preview = '',
					last_message_at = NULL,
					updated_at = NOW()
				WHERE id = $1`, conversationID,
			)
			return updateErr
		}
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE im_conversation
		SET last_message_id = $2,
			last_message_preview = $3,
			last_message_at = $4,
			updated_at = NOW()
		WHERE id = $1`,
		conversationID,
		lastMessageID,
		strings.TrimSpace(lastMessagePreview),
		lastMessageAt,
	)
	return err
}

func (a *App) deleteMessageRecordTx(ctx context.Context, tx pgx.Tx, messageID int64, conversationID int64) error {
	commandTag, err := tx.Exec(ctx, `DELETE FROM im_message WHERE id = $1`, messageID)
	if err != nil {
		return err
	}
	if commandTag.RowsAffected() <= 0 {
		return pgx.ErrNoRows
	}
	return a.syncConversationLastMessageTx(ctx, tx, conversationID)
}

func (a *App) voiceAssetStillReferenced(ctx context.Context, excludedMessageID int64, storageName string) (bool, error) {
	pattern := `%"storage_name":"` + strings.TrimSpace(storageName) + `"%`
	var exists bool
	err := a.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM im_message
			WHERE id <> $1
				AND deleted_at IS NULL
				AND message_type = 'voice'
				AND COALESCE(status, '') <> 'recalled'
				AND content_payload LIKE $2
		)`, excludedMessageID, pattern,
	).Scan(&exists)
	return exists, err
}

func (a *App) executeRecallCleanupPlan(ctx context.Context, messageID int64, plan recallCleanupPlan) error {
	if strings.TrimSpace(plan.ImageStorageName) != "" {
		a.removeImageAsset(plan.ImageStorageName)
	}
	if strings.TrimSpace(plan.FileStorageName) != "" {
		a.removeFileAssetFile(plan.FileStorageName)
		if err := a.deleteFileAssetRecord(ctx, plan.FileStorageName); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if strings.TrimSpace(plan.VoiceStorageName) != "" {
		exists, err := a.voiceAssetStillReferenced(ctx, messageID, plan.VoiceStorageName)
		if err != nil {
			return err
		}
		if !exists {
			a.removeVoiceAsset(plan.VoiceStorageName)
		}
	}
	return nil
}

func (a *App) cleanupExpiredRecalledTextMessages(ctx context.Context, limit int) error {
	if limit <= 0 {
		limit = recalledTextCleanupBatchSize
	}
	rows, err := a.db.Query(ctx, `
		SELECT id, conversation_id, sender_username, seq_no, message_type, status, sent_at
		FROM im_message
		WHERE message_type = 'text'
			AND status = 'recalled'
			AND deleted_at IS NULL
			AND sent_at <= $1
		ORDER BY sent_at ASC, id ASC
		LIMIT $2`, time.Now().Add(-messageRecallEditableWindow), limit,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := make([]MessageItem, 0, limit)
	sentAtMap := map[int64]time.Time{}
	for rows.Next() {
		var item MessageItem
		var sentAt time.Time
		if scanErr := rows.Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Status, &sentAt); scanErr != nil {
			return scanErr
		}
		items = append(items, item)
		sentAtMap[item.ID] = sentAt
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		tx, beginErr := a.db.Begin(ctx)
		if beginErr != nil {
			return beginErr
		}
		if err := a.deleteMessageRecordTx(ctx, tx, item.ID, item.ConversationID); err != nil {
			tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		deletedItem := buildDeletedMessageItem(item, sentAtMap[item.ID])
		a.broadcastConversation(item.ConversationID, map[string]any{
			"type":    "im.message.deleted",
			"payload": deletedItem,
		})
	}
	return nil
}

func (a *App) runRecalledTextCleanupLoop() {
	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if err := a.cleanupExpiredRecalledTextMessages(ctx, recalledTextCleanupBatchSize); err != nil {
			log.Printf("im recalled text cleanup failed: %v", err)
		}
	}
	runOnce()
	ticker := time.NewTicker(recalledTextCleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

func (a *App) recallDeleteMessage(ctx context.Context, tx pgx.Tx, item MessageItem, sentAt time.Time, plan recallCleanupPlan) (MessageItem, error) {
	if err := a.deleteMessageRecordTx(ctx, tx, item.ID, item.ConversationID); err != nil {
		return MessageItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MessageItem{}, err
	}
	if err := a.executeRecallCleanupPlan(ctx, item.ID, plan); err != nil {
		log.Printf("im recall cleanup failed: message_id=%d type=%s err=%v", item.ID, item.MessageType, err)
	}
	deletedItem := buildDeletedMessageItem(item, sentAt)
	return deletedItem, nil
}
