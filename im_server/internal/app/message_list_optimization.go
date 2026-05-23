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
