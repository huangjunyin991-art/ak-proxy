package app

import (
	"context"
	"log"
	"strings"
)

type userIdentityItem struct {
	Username    string
	DisplayName string
	AvatarURL   string
	HonorName   string
}

func (a *App) loadUserHonorNames(ctx context.Context, usernames []string) map[string]string {
	normalizedUsernames := normalizeUsernames(usernames)
	result := map[string]string{}
	if len(normalizedUsernames) == 0 {
		return result
	}
	rows, err := a.db.Query(ctx, `
		SELECT input.username, COALESCE(ua.honor_name, '') AS honor_name
		FROM unnest($1::text[]) AS input(username)
		LEFT JOIN user_assets ua ON ua.username = input.username`, normalizedUsernames)
	if err != nil {
		log.Printf("load user honor names failed: count=%d err=%v", len(normalizedUsernames), err)
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var username string
		var honorName string
		if err := rows.Scan(&username, &honorName); err != nil {
			log.Printf("scan user honor names failed: err=%v", err)
			continue
		}
		normalizedUsername := strings.ToLower(strings.TrimSpace(username))
		if normalizedUsername == "" {
			continue
		}
		result[normalizedUsername] = strings.TrimSpace(honorName)
	}
	if err := rows.Err(); err != nil {
		log.Printf("iterate user honor names failed: err=%v", err)
	}
	return result
}

func (a *App) buildUserIdentityItems(ctx context.Context, usernames []string) map[string]userIdentityItem {
	normalizedUsernames := normalizeUsernames(usernames)
	result := map[string]userIdentityItem{}
	if len(normalizedUsernames) == 0 {
		return result
	}
	honorNames := a.loadUserHonorNames(ctx, normalizedUsernames)
	for _, username := range normalizedUsernames {
		result[username] = userIdentityItem{
			Username:    username,
			DisplayName: a.fetchDisplayName(ctx, username),
			AvatarURL:   a.getUserAvatarURL(ctx, username),
			HonorName:   strings.TrimSpace(honorNames[username]),
		}
	}
	return result
}

func (a *App) buildUserIdentityItem(ctx context.Context, username string) userIdentityItem {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return userIdentityItem{}
	}
	items := a.buildUserIdentityItems(ctx, []string{normalizedUsername})
	if item, ok := items[normalizedUsername]; ok {
		return item
	}
	return userIdentityItem{
		Username:    normalizedUsername,
		DisplayName: a.fetchDisplayName(ctx, normalizedUsername),
		AvatarURL:   a.getUserAvatarURL(ctx, normalizedUsername),
		HonorName:   "",
	}
}

func buildSessionMemberItemFromIdentity(identity userIdentityItem, role string) SessionMemberItem {
	return SessionMemberItem{
		Username:    identity.Username,
		DisplayName: identity.DisplayName,
		AvatarURL:   identity.AvatarURL,
		HonorName:   identity.HonorName,
		Role:        role,
	}
}

func buildMessageReadProgressMemberFromIdentity(identity userIdentityItem) MessageReadProgressMember {
	return MessageReadProgressMember{
		Username:    identity.Username,
		DisplayName: identity.DisplayName,
		HonorName:   identity.HonorName,
	}
}

func buildContactItemFromIdentity(identity userIdentityItem) ContactItem {
	return ContactItem{
		Username:    identity.Username,
		DisplayName: identity.DisplayName,
		AvatarURL:   identity.AvatarURL,
		HonorName:   identity.HonorName,
	}
}
