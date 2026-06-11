package app

import (
	"context"
	"log"
	"strings"

	"im_server/internal/ai/bot"
	aiservice "im_server/internal/ai/service"
)

func (a *App) shouldTriggerAIGroupMention(ctx context.Context, username string, item MessageItem) bool {
	if a == nil || a.ai == nil || bot.IsBotUsername(strings.ToLower(strings.TrimSpace(username))) || item.ConversationID <= 0 || item.ID <= 0 {
		return false
	}
	meta, err := a.loadConversationMeta(ctx, item.ConversationID)
	if err != nil || strings.TrimSpace(meta.ConversationType) != "group" {
		return false
	}
	if messageMentionsBot(item) {
		return true
	}
	return textMentionsBot(item.MessageType, item.Content)
}

func (a *App) triggerAIGroupMentionReply(ctx context.Context, username string, item MessageItem) *aiservice.Task {
	if !a.shouldTriggerAIGroupMention(ctx, username, item) {
		return nil
	}
	task, err := a.ai.TriggerGroupMentionReply(ctx, username, item.ConversationID, item.ID)
	if err != nil {
		log.Printf("trigger AI group mention failed: conversation_id=%d username=%s err=%v", item.ConversationID, username, err)
		return nil
	}
	return &task
}

func messageMentionsBot(item MessageItem) bool {
	for _, username := range item.MentionUsernames {
		if bot.IsBotUsername(strings.ToLower(strings.TrimSpace(username))) {
			return true
		}
	}
	return false
}

func textMentionsBot(messageType string, content string) bool {
	normalizedType := strings.TrimSpace(strings.ToLower(messageType))
	if normalizedType == "" {
		normalizedType = "text"
	}
	if normalizedType != "text" {
		return false
	}
	text := normalizeMentionText(content)
	if text == "" {
		return false
	}
	lower := strings.ToLower(text)
	return strings.Contains(text, "@小A") ||
		strings.Contains(text, "@小a") ||
		strings.Contains(text, "@AK助手") ||
		strings.Contains(text, "@AI助手") ||
		strings.Contains(lower, "@ak助手") ||
		strings.Contains(lower, "@ai助手") ||
		strings.Contains(lower, "@ak_ai_assistant")
}

func appendAIVirtualMember(items []SessionMemberItem) []SessionMemberItem {
	for _, item := range items {
		if bot.IsBotUsername(strings.ToLower(strings.TrimSpace(item.Username))) {
			return items
		}
	}
	return append(items, SessionMemberItem{
		Username:    bot.Username,
		DisplayName: bot.DisplayName + " · AI助手",
		AvatarKind:  "generated",
		AvatarStyle: defaultAvatarStyle,
		AvatarSeed:  bot.AvatarSeed,
		Role:        "ai",
	})
}
