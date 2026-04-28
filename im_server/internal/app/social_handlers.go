package app

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	socialsvc "im_server/internal/app/social"
)

type socialTargetRequest struct {
	Username       string `json:"username"`
	TargetUsername string `json:"target_username"`
}

func convertSocialContactItem(item socialsvc.ContactItem) ContactItem {
	return ContactItem{
		Username:             item.Username,
		DisplayName:          item.DisplayName,
		HonorName:            item.HonorName,
		AvatarURL:            item.AvatarURL,
		Source:               item.Source,
		IsContact:            item.IsContact,
		IsBlacklisted:        item.IsBlacklisted,
		ActionDisabledReason: item.ActionDisabledReason,
	}
}

func convertSocialContactItems(items []socialsvc.ContactItem) []ContactItem {
	result := make([]ContactItem, 0, len(items))
	for _, item := range items {
		result = append(result, convertSocialContactItem(item))
	}
	return result
}

func (a *App) buildSocialIdentityItems(ctx context.Context, usernames []string) (map[string]socialsvc.IdentityItem, error) {
	result := map[string]socialsvc.IdentityItem{}
	if a == nil {
		return result, nil
	}
	identities := a.buildUserIdentityItems(ctx, usernames)
	for _, username := range normalizeUsernames(usernames) {
		identity, ok := identities[username]
		if !ok {
			result[username] = socialsvc.IdentityItem{
				Username:    username,
				DisplayName: a.fetchDisplayName(ctx, username),
				HonorName:   "",
				AvatarURL:   a.getUserAvatarURL(ctx, username),
			}
			continue
		}
		displayName := strings.TrimSpace(identity.DisplayName)
		if displayName == "" {
			displayName = username
		}
		result[username] = socialsvc.IdentityItem{
			Username:    username,
			DisplayName: displayName,
			HonorName:   strings.TrimSpace(identity.HonorName),
			AvatarURL:   strings.TrimSpace(identity.AvatarURL),
		}
	}
	return result, nil
}

func (a *App) listContactResponse(ctx context.Context, username string) ([]ContactItem, []socialsvc.ContactSection, error) {
	if a.social == nil {
		items, err := a.listWhitelistContacts(ctx, username)
		return items, nil, err
	}
	result, err := a.social.ListContacts(ctx, username)
	if err != nil {
		return nil, nil, err
	}
	return convertSocialContactItems(result.Items), result.Sections, nil
}

func (a *App) applySessionSocialRules(ctx context.Context, username string, items []SessionItem) []SessionItem {
	if a.social == nil || len(items) == 0 {
		return items
	}
	directConversationIDs := make([]int64, 0, len(items))
	for _, item := range items {
		if strings.EqualFold(item.ConversationType, "direct") && item.ConversationID > 0 {
			directConversationIDs = append(directConversationIDs, item.ConversationID)
		}
	}
	if len(directConversationIDs) == 0 {
		return items
	}
	rules, err := a.social.ListDirectSendRules(ctx, username, directConversationIDs)
	if err != nil {
		log.Printf("load direct send rules failed: username=%s err=%v", username, err)
		return items
	}
	for index := range items {
		rule, ok := rules[items[index].ConversationID]
		if !ok {
			continue
		}
		items[index].CanSend = rule.CanSend
		items[index].SendRestriction = rule.SendRestriction
		items[index].SendRestrictionHint = rule.SendRestrictionHint
		items[index].AwaitingPeerReply = rule.AwaitingPeerReply
	}
	return items
}

func decodeSocialTargetRequest(r *http.Request) (string, error) {
	var req socialTargetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return "", err
	}
	targetUsername := strings.TrimSpace(req.TargetUsername)
	if targetUsername == "" {
		targetUsername = strings.TrimSpace(req.Username)
	}
	return targetUsername, nil
}

func (a *App) handleSocialContacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	items, sections, err := a.listContactResponse(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "sections": sections})
}

func (a *App) handleSocialSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.social == nil {
		writeJSON(w, http.StatusOK, map[string]any{"items": []ContactItem{}})
		return
	}
	permissionInfo, err := a.loadUserAddFriendPermissionInfo(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	log.Printf("im add friend permission: route=social_search username=%s honor_name=%q level_code=%q can_add_friend=%t", username, permissionInfo.HonorName, permissionInfo.LevelCode, permissionInfo.CanAddFriend)
	if !permissionInfo.CanAddFriend {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "仅 M3 及以上玩家可添加好友"})
		return
	}
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	if keyword == "" {
		keyword = strings.TrimSpace(r.URL.Query().Get("q"))
	}
	items, err := a.social.SearchUsers(r.Context(), username, keyword, 20)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": convertSocialContactItems(items)})
}

func (a *App) handleSocialContactsAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.social == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "social service unavailable"})
		return
	}
	permissionInfo, err := a.loadUserAddFriendPermissionInfo(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	log.Printf("im add friend permission: route=social_contacts_add username=%s honor_name=%q level_code=%q can_add_friend=%t", username, permissionInfo.HonorName, permissionInfo.LevelCode, permissionInfo.CanAddFriend)
	if !permissionInfo.CanAddFriend {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "仅 M3 及以上玩家可添加好友"})
		return
	}
	targetUsername, err := decodeSocialTargetRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	item, err := a.social.AddContact(r.Context(), username, targetUsername)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": convertSocialContactItem(item)})
}

func (a *App) handleSocialBlacklist(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.social == nil {
		writeJSON(w, http.StatusOK, map[string]any{"items": []ContactItem{}})
		return
	}
	items, err := a.social.ListBlacklist(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": convertSocialContactItems(items)})
}

func (a *App) handleSocialBlacklistAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.social == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "social service unavailable"})
		return
	}
	targetUsername, err := decodeSocialTargetRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	item, err := a.social.AddToBlacklist(r.Context(), username, targetUsername)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": convertSocialContactItem(item)})
}

func (a *App) handleSocialBlacklistRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if a.social == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "social service unavailable"})
		return
	}
	targetUsername, err := decodeSocialTargetRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if err := a.social.RemoveFromBlacklist(r.Context(), username, targetUsername); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
