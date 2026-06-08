package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type callOutcomePayload struct {
	CallID          string `json:"call_id"`
	ConversationID  int64  `json:"conversation_id"`
	Event           string `json:"event"`
	Reason          string `json:"reason"`
	CallKind        string `json:"call_kind"`
	CallerUsername  string `json:"caller_username"`
	CalleeUsername  string `json:"callee_username"`
	Actor           string `json:"actor"`
	ActorRole       string `json:"actor_role"`
	DurationSeconds int64  `json:"duration_seconds"`
	DurationText    string `json:"duration_text"`
}

func normalizeCallOutcomeReason(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "rejected", "reject":
		return "rejected"
	case "timeout":
		return "timeout"
	case "cancel", "cancelled":
		return "cancel"
	case "hangup":
		return "hangup"
	default:
		if normalized != "" {
			return normalized
		}
		return "hangup"
	}
}

func callOutcomeWasConnected(session *imCallSession) bool {
	if session == nil {
		return false
	}
	return !session.ConnectedAt.IsZero() || !session.AcceptedAt.IsZero()
}

func formatCallOutcomeDuration(seconds int64) string {
	if seconds < 0 {
		seconds = 0
	}
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	remainingSeconds := seconds % 60
	if hours > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, remainingSeconds)
	}
	return fmt.Sprintf("%02d:%02d", minutes, remainingSeconds)
}

func buildCallOutcomePayload(session *imCallSession, reason string, actorUsername string, actorRole string) callOutcomePayload {
	normalizedReason := normalizeCallOutcomeReason(reason)
	normalizedActor := normalizeCallUsername(actorUsername)
	normalizedActorRole := strings.ToLower(strings.TrimSpace(actorRole))
	if normalizedActor == "" {
		normalizedActor = normalizeCallUsername(session.CallerUsername)
	}
	if normalizedActorRole == "" {
		normalizedActorRole = "caller"
	}
	eventName := "cancelled"
	if normalizedReason == "rejected" {
		eventName = "rejected"
	} else if callOutcomeWasConnected(session) {
		eventName = "completed"
	}
	durationSeconds := int64(0)
	if eventName == "completed" {
		start := session.ConnectedAt
		if start.IsZero() {
			start = session.AcceptedAt
		}
		end := session.EndedAt
		if end.IsZero() {
			end = time.Now()
		}
		durationSeconds = int64(end.Sub(start).Seconds())
		if durationSeconds < 0 {
			durationSeconds = 0
		}
	}
	return callOutcomePayload{
		CallID:          strings.TrimSpace(session.CallID),
		ConversationID:  session.ConversationID,
		Event:           eventName,
		Reason:          normalizedReason,
		CallKind:        normalizeCallKind(session.CallKind),
		CallerUsername:  normalizeCallUsername(session.CallerUsername),
		CalleeUsername:  normalizeCallUsername(session.CalleeUsername),
		Actor:           normalizedActor,
		ActorRole:       normalizedActorRole,
		DurationSeconds: durationSeconds,
		DurationText:    formatCallOutcomeDuration(durationSeconds),
	}
}

func buildCallOutcomePreview(payload callOutcomePayload) string {
	prefix := "语音通话"
	if normalizeCallKind(payload.CallKind) == "video" {
		prefix = "视频通话"
	}
	switch payload.Event {
	case "completed":
		durationText := strings.TrimSpace(payload.DurationText)
		if durationText == "" {
			durationText = "00:00"
		}
		return prefix + " 通话时长 " + durationText
	case "rejected":
		return prefix + " 已拒接"
	default:
		if payload.Reason == "timeout" {
			return prefix + " 未接通"
		}
		return prefix + " 已取消"
	}
}

func (a *App) emitCallOutcomeMessage(ctx context.Context, session *imCallSession, reason string, actorUsername string, actorRole string) (MessageItem, bool, error) {
	if a == nil || a.db == nil || session == nil {
		return MessageItem{}, false, nil
	}
	payload := buildCallOutcomePayload(session, reason, actorUsername, actorRole)
	if payload.CallID == "" || payload.ConversationID <= 0 {
		return MessageItem{}, false, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	contentBytes, err := json.Marshal(payload)
	if err != nil {
		return MessageItem{}, false, err
	}
	contentPayload := string(contentBytes)
	contentPreview := buildCallOutcomePreview(payload)
	senderUsername := payload.Actor
	if senderUsername == "" {
		senderUsername = payload.CallerUsername
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return MessageItem{}, false, err
	}
	defer tx.Rollback(ctx)
	var claimedCallID string
	err = tx.QueryRow(ctx, `
		INSERT INTO im_call_outcome_message (call_id, conversation_id, outcome)
		VALUES ($1, $2, $3)
		ON CONFLICT (call_id) DO NOTHING
		RETURNING call_id`,
		payload.CallID, payload.ConversationID, payload.Event,
	).Scan(&claimedCallID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MessageItem{}, false, nil
		}
		return MessageItem{}, false, err
	}
	nextSeqNo, err := a.allocateMessageSeqNoTx(ctx, tx, payload.ConversationID)
	if err != nil {
		return MessageItem{}, false, err
	}
	var item MessageItem
	var sentAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO im_message (conversation_id, sender_username, seq_no, message_type, content_preview, content_payload, content_size_raw, content_size_stored, sent_at)
		VALUES ($1, $2, $3, 'call_event', $4, $5, $6, $7, timezone('Asia/Shanghai', NOW()))
		RETURNING id, conversation_id, sender_username, seq_no, message_type, content_payload, content_preview, status, sent_at`,
		payload.ConversationID, senderUsername, nextSeqNo, contentPreview, contentPayload, len(contentPayload), len(contentPayload),
	).Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt)
	if err != nil {
		return MessageItem{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE im_call_outcome_message SET message_id = $1, updated_at = NOW() WHERE call_id = $2`, item.ID, payload.CallID); err != nil {
		return MessageItem{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE im_conversation SET last_message_id = $1, last_message_preview = $2, last_message_at = timezone('Asia/Shanghai', NOW()), updated_at = NOW() WHERE id = $3`, item.ID, item.ContentPreview, payload.ConversationID); err != nil {
		return MessageItem{}, false, err
	}
	if senderUsername != "" {
		if _, err := tx.Exec(ctx, `UPDATE im_conversation_member SET last_read_seq_no = GREATEST(last_read_seq_no, $1), last_read_at = NOW(), updated_at = NOW() WHERE conversation_id = $2 AND username = $3`, item.SeqNo, payload.ConversationID, senderUsername); err != nil {
			return MessageItem{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return MessageItem{}, false, err
	}
	item.SentAt = formatIMTimestamp(sentAt)
	senderIdentity := a.buildUserIdentityItem(ctx, item.SenderUsername)
	item.SenderDisplayName = senderIdentity.DisplayName
	item.SenderHonorName = senderIdentity.HonorName
	item.SenderAvatarKind = senderIdentity.AvatarKind
	item.SenderAvatarStyle = senderIdentity.AvatarStyle
	item.SenderAvatarSeed = senderIdentity.AvatarSeed
	item.SenderAvatarURL = senderIdentity.AvatarURL
	item = a.normalizeOutgoingMessageItem(ctx, item)
	members, err := a.listConversationMembers(ctx, payload.ConversationID)
	if err == nil {
		items := []MessageItem{item}
		a.populateMessageReadProgress(items, members, senderUsername)
		item = items[0]
	}
	a.broadcastMessageCreated(ctx, payload.ConversationID, item, members)
	return item, true, nil
}
