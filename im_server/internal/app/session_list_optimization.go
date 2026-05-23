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

func (a *App) enrichSessionItems(ctx context.Context, username string, items []SessionItem) []SessionItem {
	if len(items) == 0 {
		return items
	}
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
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
		} else if strings.EqualFold(items[index].OwnerUsername, normalizedUsername) {
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
	rows, err := a.db.Query(ctx, `
		SELECT c.id,
		       CASE
		           WHEN LOWER(COALESCE(c.owner_username, '')) = $2 THEN 'owner'
		           WHEN EXISTS(
		               SELECT 1
		               FROM im_conversation_admin admin
		               WHERE admin.conversation_id = c.id AND admin.username = $2 AND admin.revoked_at IS NULL
		           ) THEN 'admin'
		           ELSE 'member'
		       END AS my_role
		FROM im_conversation c
		WHERE c.id = ANY($1::bigint[])`, groupIDs, username)
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
		           cm.mute_until
		    FROM im_conversation_member cm
		    JOIN im_conversation c ON c.id = cm.conversation_id
		    LEFT JOIN im_conversation_admin admin ON admin.conversation_id = cm.conversation_id AND admin.username = cm.username AND admin.revoked_at IS NULL
		    WHERE cm.conversation_id = ANY($1::bigint[]) AND cm.left_at IS NULL
		) members
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
