package app

import (
	"context"
	"log"
	"sort"
	"strings"
	"time"
)

func uniqueSessionConversationIDs(items []SessionItem) []int64 {
	seen := map[int64]struct{}{}
	ids := make([]int64, 0)
	for _, item := range items {
		if item.ConversationID <= 0 || item.ConversationType != "group" {
			continue
		}
		if _, ok := seen[item.ConversationID]; ok {
			continue
		}
		seen[item.ConversationID] = struct{}{}
		ids = append(ids, item.ConversationID)
	}
	return ids
}

func collectSessionPeerUsernames(items []SessionItem) []string {
	usernames := make([]string, 0)
	for _, item := range items {
		if item.ConversationType == "group" {
			continue
		}
		username := strings.ToLower(strings.TrimSpace(item.PeerUsername))
		if username != "" {
			usernames = append(usernames, username)
		}
	}
	return normalizeUsernames(usernames)
}

func (a *App) loadSessionItems(ctx context.Context, username string) ([]SessionItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	canonicalUsername, candidateUsernames := a.identityLookupUsernames(ctx, normalizedUsername, true)
	if canonicalUsername == "" {
		canonicalUsername = normalizedUsername
	}
	if len(candidateUsernames) == 0 {
		candidateUsernames = []string{canonicalUsername}
	}
	rows, err := a.db.Query(ctx, `
		WITH visible AS (
			SELECT c.id,
			       c.conversation_type,
			       COALESCE(c.title, '') AS conversation_title,
			       COALESCE(c.avatar_url, '') AS avatar_url,
			       COALESCE(c.owner_username, '') AS owner_username,
			       COALESCE(c.all_muted, FALSE) AS all_muted,
			       COALESCE(c.all_muted_by, '') AS all_muted_by,
			       c.all_muted_at,
			       COALESCE(c.purged_before_seq_no, 0) AS purged_before_seq_no,
			       COALESCE(cm.last_read_seq_no, 0) AS last_read_seq_no,
			       cm.joined_at,
			       cm.mute_until,
			       COALESCE(cm.pin_type, 'none') AS pin_type,
			       cm.pinned_at,
			       COALESCE(c.last_message_id, 0) AS last_message_id,
			       COALESCE(c.last_message_preview, '') AS last_message_preview,
			       c.last_message_at,
			       c.created_at
			FROM im_conversation c
			JOIN LATERAL (
				SELECT cm.last_read_seq_no,
				       cm.joined_at,
				       cm.mute_until,
				       COALESCE(cm.pin_type, 'none') AS pin_type,
				       cm.pinned_at
				FROM im_conversation_member cm
				WHERE cm.conversation_id = c.id
				  AND cm.username = ANY($1::text[])
				  AND cm.left_at IS NULL
				ORDER BY CASE WHEN cm.username = $2 THEN 0 ELSE 1 END,
				         cm.joined_at DESC NULLS LAST,
				         cm.id DESC
				LIMIT 1
			) cm ON TRUE
			WHERE c.deleted_at IS NULL AND COALESCE(c.hidden_for_all, FALSE) = FALSE
		),
		member_counts AS (
			SELECT member.conversation_id, COUNT(1) AS member_count
			FROM im_conversation_member member
			JOIN visible v ON v.id = member.conversation_id
			WHERE member.left_at IS NULL
			GROUP BY member.conversation_id
		),
		peers AS (
			SELECT peer.conversation_id, MIN(peer.username) AS peer_username
			FROM im_conversation_member peer
			JOIN visible v ON v.id = peer.conversation_id
			WHERE peer.username <> ALL($1::text[]) AND peer.left_at IS NULL
			GROUP BY peer.conversation_id
		),
		unread AS (
			SELECT v.id AS conversation_id, COUNT(m.id) AS unread_count
			FROM visible v
			JOIN im_message m ON m.conversation_id = v.id
			WHERE m.deleted_at IS NULL
			  AND m.sender_username <> ALL($1::text[])
			  AND m.seq_no > v.last_read_seq_no
			  AND m.seq_no > v.purged_before_seq_no
			  AND m.sent_at + INTERVAL '2 seconds' >= v.joined_at
			GROUP BY v.id
		),
		mention_unread AS (
			SELECT v.id AS conversation_id,
			       COUNT(DISTINCT m.id) AS mention_unread_count,
			       BOOL_OR(mm.mentioned_username = ANY($1::text[]) AND mm.mention_all = FALSE) AS mention_me_unread,
			       BOOL_OR(mm.mention_all = TRUE) AS mention_all_unread
			FROM visible v
			JOIN im_message_mention mm ON mm.conversation_id = v.id
			JOIN im_message m ON m.id = mm.message_id
			WHERE m.deleted_at IS NULL
			  AND m.sender_username <> ALL($1::text[])
			  AND m.seq_no > v.last_read_seq_no
			  AND m.seq_no > v.purged_before_seq_no
			  AND m.sent_at + INTERVAL '2 seconds' >= v.joined_at
			  AND (mm.mention_all = TRUE OR mm.mentioned_username = ANY($1::text[]))
			GROUP BY v.id
		)
		SELECT v.id,
		       v.conversation_type,
		       v.conversation_title,
		       v.avatar_url,
		       v.owner_username,
		       COALESCE(mc.member_count, 0) AS member_count,
		       v.all_muted,
		       v.all_muted_by,
		       v.all_muted_at,
		       v.mute_until,
		       v.pin_type,
		       v.pinned_at,
		       v.last_message_id,
		       COALESCE(lm.message_type, '') AS last_message_type,
		       v.last_message_preview,
		       v.last_message_at,
		       COALESCE(u.unread_count, 0) AS unread_count,
		       COALESCE(mu.mention_unread_count, 0) AS mention_unread_count,
		       COALESCE(mu.mention_me_unread, FALSE) AS mention_me_unread,
		       COALESCE(mu.mention_all_unread, FALSE) AS mention_all_unread,
		       COALESCE(p.peer_username, '') AS peer_username
		FROM visible v
		LEFT JOIN im_message lm ON lm.id = v.last_message_id
		LEFT JOIN member_counts mc ON mc.conversation_id = v.id
		LEFT JOIN unread u ON u.conversation_id = v.id
		LEFT JOIN mention_unread mu ON mu.conversation_id = v.id
		LEFT JOIN peers p ON p.conversation_id = v.id
		ORDER BY CASE v.pin_type WHEN 'system' THEN 2 WHEN 'manual' THEN 1 ELSE 0 END DESC,
		         COALESCE(v.pinned_at, v.last_message_at, v.created_at) DESC,
		         COALESCE(v.last_message_at, v.created_at) DESC`, candidateUsernames, canonicalUsername)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]SessionItem, 0)
	now := time.Now()
	for rows.Next() {
		var item SessionItem
		var lastMessageAt *time.Time
		var pinnedAt *time.Time
		var allMutedAt *time.Time
		var muteUntil *time.Time
		if err := rows.Scan(&item.ConversationID, &item.ConversationType, &item.ConversationTitle, &item.AvatarURL, &item.OwnerUsername, &item.MemberCount, &item.AllMuted, &item.AllMutedBy, &allMutedAt, &muteUntil, &item.PinType, &pinnedAt, &item.LastMessageID, &item.LastMessageType, &item.LastMessagePreview, &lastMessageAt, &item.UnreadCount, &item.MentionUnreadCount, &item.MentionMeUnread, &item.MentionAllUnread, &item.PeerUsername); err != nil {
			return nil, err
		}
		item.AllMutedBy = strings.ToLower(strings.TrimSpace(item.AllMutedBy))
		item.AllMutedAt = formatOptionalTime(allMutedAt)
		item.MutedUntil = formatOptionalTime(muteUntil)
		item.IsPinned = item.PinType == "system" || item.PinType == "manual"
		if pinnedAt != nil {
			item.PinnedAt = formatIMTimestamp(*pinnedAt)
		}
		if lastMessageAt != nil {
			item.LastMessageAt = formatIMTimestamp(*lastMessageAt)
		}
		item.CanSend = true
		if item.ConversationType == "group" && muteUntil != nil && muteUntil.After(now) {
			item.CanSend = false
			item.SendRestriction = "group_mute"
			item.SendRestrictionHint = "你已被禁言"
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (a *App) enrichSessionItems(ctx context.Context, username string, items []SessionItem) []SessionItem {
	if len(items) == 0 {
		return items
	}
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	_, candidateUsernames := a.identityLookupUsernames(ctx, normalizedUsername, true)
	peerIdentities := a.buildUserIdentityItems(ctx, collectSessionPeerUsernames(items))
	groupIDs := uniqueSessionConversationIDs(items)
	roles, err := a.loadSessionGroupRoles(ctx, normalizedUsername, groupIDs)
	if err != nil {
		log.Printf("load session group roles failed: username=%s groups=%d err=%v", normalizedUsername, len(groupIDs), err)
		roles = map[int64]string{}
	}
	previews, err := a.loadSessionMembersPreviewMap(ctx, groupIDs)
	if err != nil {
		log.Printf("load session members preview map failed: groups=%d err=%v", len(groupIDs), err)
		previews = map[int64][]SessionMemberItem{}
	}
	for index := range items {
		if items[index].ConversationType != "group" {
			peerUsername := strings.ToLower(strings.TrimSpace(items[index].PeerUsername))
			peerIdentity, ok := peerIdentities[peerUsername]
			if !ok {
				peerIdentity = a.buildUserIdentityItem(ctx, peerUsername)
			}
			items[index].PeerDisplayName = peerIdentity.DisplayName
			items[index].PeerHonorName = peerIdentity.HonorName
			items[index].AvatarKind = peerIdentity.AvatarKind
			items[index].AvatarStyle = peerIdentity.AvatarStyle
			items[index].AvatarSeed = peerIdentity.AvatarSeed
			items[index].AvatarURL = peerIdentity.AvatarURL
			continue
		}
		if strings.TrimSpace(items[index].AvatarURL) != "" {
			items[index].AvatarKind = "custom"
		}
		if strings.TrimSpace(items[index].ConversationTitle) == "" {
			items[index].ConversationTitle = "内部群聊"
		}
		items[index].PeerDisplayName = items[index].ConversationTitle
		items[index].PeerUsername = ""
		if role := strings.ToLower(strings.TrimSpace(roles[items[index].ConversationID])); role != "" {
			items[index].MyRole = role
		} else if identityHasUsername(candidateUsernames, items[index].OwnerUsername) {
			items[index].MyRole = "owner"
		} else {
			items[index].MyRole = "member"
		}
		if preview, ok := previews[items[index].ConversationID]; ok {
			items[index].MembersPreview = preview
		}
		if items[index].CanSend && items[index].AllMuted && items[index].MyRole != "owner" && items[index].MyRole != "admin" {
			items[index].CanSend = false
			items[index].SendRestriction = "group_mute"
			items[index].SendRestrictionHint = "全体禁言中，仅群主和管理员可发言"
		}
	}
	return items
}

func (a *App) loadSessionGroupRoles(ctx context.Context, username string, groupIDs []int64) (map[int64]string, error) {
	result := map[int64]string{}
	if len(groupIDs) == 0 || username == "" {
		return result, nil
	}
	canonicalUsername, candidateUsernames := a.identityLookupUsernames(ctx, username, true)
	if canonicalUsername == "" {
		canonicalUsername = strings.ToLower(strings.TrimSpace(username))
	}
	if len(candidateUsernames) == 0 {
		candidateUsernames = []string{canonicalUsername}
	}
	rows, err := a.db.Query(ctx, `
		SELECT c.id,
		       CASE
		           WHEN LOWER(COALESCE(c.owner_username, '')) = ANY($2::text[]) THEN 'owner'
		           WHEN EXISTS(
		               SELECT 1
		               FROM im_conversation_admin admin
		               WHERE admin.conversation_id = c.id AND admin.username = ANY($2::text[]) AND admin.revoked_at IS NULL
		           ) THEN 'admin'
		           ELSE 'member'
		       END AS my_role
		FROM im_conversation c
		WHERE c.id = ANY($1::bigint[])`, groupIDs, candidateUsernames)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var conversationID int64
		var role string
		if err := rows.Scan(&conversationID, &role); err != nil {
			return result, err
		}
		result[conversationID] = strings.ToLower(strings.TrimSpace(role))
	}
	return result, rows.Err()
}

type sessionPreviewMemberRow struct {
	ConversationID int64
	Username       string
	Role           string
	MutedUntil     string
}

func (a *App) loadSessionMembersPreviewMap(ctx context.Context, groupIDs []int64) (map[int64][]SessionMemberItem, error) {
	result := map[int64][]SessionMemberItem{}
	if len(groupIDs) == 0 {
		return result, nil
	}
	rows, err := a.db.Query(ctx, `
		SELECT conversation_id, username, role, mute_until
		FROM (
		    SELECT cm.conversation_id,
		           LOWER(TRIM(cm.username)) AS username,
		           CASE
		               WHEN LOWER(TRIM(cm.username)) = LOWER(TRIM(COALESCE(c.owner_username, ''))) THEN 'owner'
		               WHEN admin.username IS NOT NULL THEN 'admin'
		               ELSE COALESCE(NULLIF(cm.role, ''), 'member')
		           END AS role,
		           cm.mute_until,
		           ROW_NUMBER() OVER (
		               PARTITION BY cm.conversation_id
		               ORDER BY
		                   CASE
		                       WHEN LOWER(TRIM(cm.username)) = LOWER(TRIM(COALESCE(c.owner_username, ''))) THEN 0
		                       WHEN admin.username IS NOT NULL THEN 1
		                       ELSE 2
		                   END ASC,
		                   LOWER(TRIM(cm.username)) ASC
		           ) AS preview_rank
		    FROM im_conversation_member cm
		    JOIN im_conversation c ON c.id = cm.conversation_id
		    LEFT JOIN im_conversation_admin admin ON admin.conversation_id = cm.conversation_id AND admin.username = cm.username AND admin.revoked_at IS NULL
		    WHERE cm.conversation_id = ANY($1::bigint[]) AND cm.left_at IS NULL
		) members
		WHERE preview_rank <= 9
		ORDER BY conversation_id ASC, LOWER(username) ASC`, groupIDs)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	rowsByConversation := map[int64][]sessionPreviewMemberRow{}
	memberUsernames := make([]string, 0)
	for rows.Next() {
		var item sessionPreviewMemberRow
		var muteUntil *time.Time
		if err := rows.Scan(&item.ConversationID, &item.Username, &item.Role, &muteUntil); err != nil {
			return result, err
		}
		item.Username = strings.ToLower(strings.TrimSpace(item.Username))
		item.Role = strings.ToLower(strings.TrimSpace(item.Role))
		item.MutedUntil = formatOptionalTime(muteUntil)
		if item.Username == "" || item.ConversationID <= 0 {
			continue
		}
		rowsByConversation[item.ConversationID] = append(rowsByConversation[item.ConversationID], item)
		memberUsernames = append(memberUsernames, item.Username)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	identities := a.buildUserIdentityItems(ctx, memberUsernames)
	for conversationID, rows := range rowsByConversation {
		items := make([]SessionMemberItem, 0, len(rows))
		for _, row := range rows {
			identity, ok := identities[row.Username]
			if !ok {
				identity = a.buildUserIdentityItem(ctx, row.Username)
			}
			member := buildSessionMemberItemFromIdentity(identity, row.Role)
			member.MutedUntil = row.MutedUntil
			items = append(items, member)
		}
		sort.Slice(items, func(left int, right int) bool {
			leftName := strings.TrimSpace(items[left].DisplayName)
			rightName := strings.TrimSpace(items[right].DisplayName)
			if leftName == rightName {
				return items[left].Username < items[right].Username
			}
			return leftName < rightName
		})
		result[conversationID] = sortSessionMembersForPreview(items)
	}
	return result, nil
}
