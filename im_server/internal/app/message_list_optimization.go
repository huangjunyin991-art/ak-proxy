package app

import (
	"context"
	"strings"
)

func collectMessageSenderUsernames(items []MessageItem) []string {
	usernames := make([]string, 0)
	for _, item := range items {
		username := strings.ToLower(strings.TrimSpace(item.SenderUsername))
		if username != "" {
			usernames = append(usernames, username)
		}
	}
	return normalizeUsernames(usernames)
}

func (a *App) enrichMessageSenderIdentities(ctx context.Context, items []MessageItem) []MessageItem {
	if len(items) == 0 {
		return items
	}
	identities := a.buildUserIdentityItems(ctx, collectMessageSenderUsernames(items))
	for index := range items {
		username := strings.ToLower(strings.TrimSpace(items[index].SenderUsername))
		identity, ok := identities[username]
		if !ok {
			identity = a.buildUserIdentityItem(ctx, username)
		}
		items[index].SenderDisplayName = identity.DisplayName
		items[index].SenderHonorName = identity.HonorName
		items[index].SenderAvatarKind = identity.AvatarKind
		items[index].SenderAvatarStyle = identity.AvatarStyle
		items[index].SenderAvatarSeed = identity.AvatarSeed
		items[index].SenderAvatarURL = identity.AvatarURL
		items[index] = a.normalizeOutgoingMessageItem(ctx, items[index])
	}
	return items
}

func collectReplyToMessageIDs(items []MessageItem) []int64 {
	ids := make([]int64, 0)
	seen := map[int64]struct{}{}
	for _, item := range items {
		id := item.ReplyToMessageID
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

func (a *App) populateMessageReplies(ctx context.Context, items []MessageItem) {
	if a == nil || a.db == nil || len(items) == 0 {
		return
	}
	ids := collectReplyToMessageIDs(items)
	if len(ids) == 0 {
		return
	}
	rows, err := a.db.Query(ctx, `
		SELECT m.id, m.sender_username, m.message_type, m.content_preview, m.status
		FROM im_message m
		WHERE m.id = ANY($1::bigint[])`, ids)
	if err != nil {
		return
	}
	defer rows.Close()
	quotes := map[int64]*MessageQuoteItem{}
	usernames := make([]string, 0, len(ids))
	for rows.Next() {
		var quote MessageQuoteItem
		if err := rows.Scan(&quote.ID, &quote.SenderUsername, &quote.MessageType, &quote.ContentPreview, &quote.Status); err != nil {
			return
		}
		quote.SenderUsername = strings.ToLower(strings.TrimSpace(quote.SenderUsername))
		quote.ContentPreview = strings.TrimSpace(quote.ContentPreview)
		quotes[quote.ID] = &quote
		if quote.SenderUsername != "" {
			usernames = append(usernames, quote.SenderUsername)
		}
	}
	identities := a.buildUserIdentityItems(ctx, normalizeUsernames(usernames))
	for _, quote := range quotes {
		if quote == nil {
			continue
		}
		if identity, ok := identities[quote.SenderUsername]; ok {
			quote.SenderDisplayName = identity.DisplayName
		}
	}
	for index := range items {
		if quote := quotes[items[index].ReplyToMessageID]; quote != nil {
			copied := *quote
			items[index].ReplyTo = &copied
		}
	}
}
