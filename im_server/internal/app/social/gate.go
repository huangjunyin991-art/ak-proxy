package social

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5"
)

type txQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type directConversationSnapshot struct {
	ConversationID    int64
	ConversationType  string
	PeerUsername      string
	InitiatorUsername string
	ReplyUnlocked     bool
	SelfBlockedPeer   bool
	BlockedByPeer     bool
}

func (s *Service) loadDirectConversationSnapshot(ctx context.Context, query txQueryer, username string, conversationID int64) (directConversationSnapshot, error) {
	snapshot := directConversationSnapshot{ConversationID: conversationID}
	normalizedUsername := normalizeUsername(username)
	if normalizedUsername == "" || conversationID <= 0 {
		return snapshot, nil
	}
	err := query.QueryRow(ctx, `
		SELECT COALESCE(c.conversation_type, ''),
			COALESCE((
				SELECT peer.username
				FROM im_conversation_member peer
				WHERE peer.conversation_id = c.id AND peer.username <> $2 AND peer.left_at IS NULL
				ORDER BY peer.username ASC
				LIMIT 1
			), ''),
			COALESCE(g.initiator_username, ''),
			COALESCE(g.reply_unlocked_at IS NOT NULL, FALSE),
			EXISTS(
				SELECT 1 FROM im_user_blacklist b
				WHERE b.owner_username = $2 AND b.target_username = (
					SELECT peer.username
					FROM im_conversation_member peer
					WHERE peer.conversation_id = c.id AND peer.username <> $2 AND peer.left_at IS NULL
					ORDER BY peer.username ASC
					LIMIT 1
				) AND b.deleted_at IS NULL
			),
			EXISTS(
				SELECT 1 FROM im_user_blacklist b
				WHERE b.owner_username = (
					SELECT peer.username
					FROM im_conversation_member peer
					WHERE peer.conversation_id = c.id AND peer.username <> $2 AND peer.left_at IS NULL
					ORDER BY peer.username ASC
					LIMIT 1
				) AND b.target_username = $2 AND b.deleted_at IS NULL
			)
		FROM im_conversation c
		LEFT JOIN im_direct_message_gate g ON g.conversation_id = c.id
		WHERE c.id = $1 AND c.deleted_at IS NULL`, conversationID, normalizedUsername).Scan(
		&snapshot.ConversationType,
		&snapshot.PeerUsername,
		&snapshot.InitiatorUsername,
		&snapshot.ReplyUnlocked,
		&snapshot.SelfBlockedPeer,
		&snapshot.BlockedByPeer,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return snapshot, nil
		}
		return snapshot, err
	}
	snapshot.ConversationType = strings.ToLower(strings.TrimSpace(snapshot.ConversationType))
	snapshot.PeerUsername = normalizeUsername(snapshot.PeerUsername)
	snapshot.InitiatorUsername = normalizeUsername(snapshot.InitiatorUsername)
	return snapshot, nil
}

func buildDirectSendRule(username string, snapshot directConversationSnapshot) DirectSendRule {
	rule := DirectSendRule{
		ConversationID: snapshot.ConversationID,
		PeerUsername:   snapshot.PeerUsername,
		CanSend:        true,
	}
	if snapshot.ConversationType != "direct" {
		return rule
	}
	if snapshot.SelfBlockedPeer {
		rule.CanSend = false
		rule.SendRestriction = SendRestrictionBlocked
		rule.SendRestrictionHint = "你已将对方加入黑名单"
		rule.SelfBlacklistedPeer = true
		return rule
	}
	if snapshot.BlockedByPeer {
		rule.CanSend = false
		rule.SendRestriction = SendRestrictionBlocked
		rule.SendRestrictionHint = "对方暂不接收你的消息"
		rule.BlockedByPeer = true
		return rule
	}
	if snapshot.InitiatorUsername != "" && !snapshot.ReplyUnlocked && normalizeUsername(username) == snapshot.InitiatorUsername {
		rule.CanSend = false
		rule.SendRestriction = SendRestrictionAwaitingReply
		rule.SendRestrictionHint = "对方回复前你只能发送一条消息"
		rule.AwaitingPeerReply = true
	}
	return rule
}

func (s *Service) GetDirectSendRule(ctx context.Context, username string, conversationID int64) (DirectSendRule, error) {
	if s == nil || s.db == nil || conversationID <= 0 {
		return DirectSendRule{ConversationID: conversationID, CanSend: true}, nil
	}
	snapshot, err := s.loadDirectConversationSnapshot(ctx, s.db, username, conversationID)
	if err != nil {
		return DirectSendRule{}, err
	}
	return buildDirectSendRule(username, snapshot), nil
}

func (s *Service) ListDirectSendRules(ctx context.Context, username string, conversationIDs []int64) (map[int64]DirectSendRule, error) {
	result := map[int64]DirectSendRule{}
	for _, conversationID := range conversationIDs {
		if conversationID <= 0 {
			continue
		}
		rule, err := s.GetDirectSendRule(ctx, username, conversationID)
		if err != nil {
			return nil, err
		}
		result[conversationID] = rule
	}
	return result, nil
}

func (s *Service) AssertCanSendMessageTx(ctx context.Context, tx pgx.Tx, username string, conversationID int64) error {
	if s == nil || conversationID <= 0 {
		return nil
	}
	snapshot, err := s.loadDirectConversationSnapshot(ctx, tx, username, conversationID)
	if err != nil {
		return err
	}
	rule := buildDirectSendRule(username, snapshot)
	if !rule.CanSend {
		return &SendRestrictedError{Rule: rule}
	}
	return nil
}

func (s *Service) AfterMessageSentTx(ctx context.Context, tx pgx.Tx, username string, conversationID int64, messageID int64) error {
	if s == nil || conversationID <= 0 || messageID <= 0 {
		return nil
	}
	snapshot, err := s.loadDirectConversationSnapshot(ctx, tx, username, conversationID)
	if err != nil {
		return err
	}
	if snapshot.ConversationType != "direct" {
		return nil
	}
	normalizedUsername := normalizeUsername(username)
	if snapshot.InitiatorUsername == "" {
		_, err = tx.Exec(ctx, `
			INSERT INTO im_direct_message_gate (conversation_id, initiator_username, first_message_id, first_message_sent_at, updated_at)
			VALUES ($1, $2, $3, NOW(), NOW())
			ON CONFLICT (conversation_id) DO NOTHING`, conversationID, normalizedUsername, messageID)
		return err
	}
	if snapshot.ReplyUnlocked {
		return nil
	}
	if snapshot.InitiatorUsername != normalizedUsername {
		_, err = tx.Exec(ctx, `
			UPDATE im_direct_message_gate
			SET reply_unlocked_at = COALESCE(reply_unlocked_at, NOW()), updated_at = NOW()
			WHERE conversation_id = $1`, conversationID)
		return err
	}
	return nil
}
