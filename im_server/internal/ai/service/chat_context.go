package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"im_server/internal/ai/bot"
	"im_server/internal/ai/provider"
)

const groupMentionAction = "group_mention"

type chatContextMessage struct {
	ID            int64
	SeqNo         int64
	Sender        string
	DisplayName   string
	MessageType   string
	Content       string
	IsTrigger     bool
	IsQuotedFocus bool
}

func parseTaskPayload(raw string) map[string]any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil
	}
	return payload
}

func isGroupMentionTask(payload map[string]any) bool {
	return taskPayloadString(payload, "action") == groupMentionAction ||
		taskPayloadString(payload, "context_mode") == "conversation_mention"
}

func taskPayloadString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(fmt.Sprint(payload[key])))
}

func (s *Service) buildMentionContextMessages(ctx context.Context, ownerUsername string, conversationID int64, triggerMessageID int64, cfg RuntimeConfig, taskPayload map[string]any) ([]provider.Message, error) {
	trigger, quoteID, err := s.loadChatContextTrigger(ctx, conversationID, triggerMessageID)
	if err != nil {
		return nil, err
	}
	items, err := s.loadRecentHumanChatContext(ctx, conversationID, trigger.SeqNo, triggerMessageID, quoteID, cfg)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		items = []chatContextMessage{trigger}
	}
	s.enrichChatContextDisplayNames(ctx, items)
	contextText := renderChatContextTranscript(items)
	triggerText := cleanBotMentionText(trigger.Content)
	if triggerText == "" {
		triggerText = trigger.Content
	}
	quotedText := ""
	for _, item := range items {
		if item.IsQuotedFocus {
			quotedText = fmt.Sprintf("%s(@%s)：%s", displayNameOrUsername(item), item.Sender, item.Content)
			break
		}
	}
	system := strings.Join([]string{
		buildChatSystemPrompt("", cfg),
		"你正在当前聊天会话中被用户@。你可以基于下面提供的最近真人聊天记录回答用户问题。",
		"聊天记录已经排除了小A历史回复，避免AI长回复污染上下文；不要把缺失的小A历史回复当作用户没说过相关内容。",
		"如果用户询问参与人数、观点、待办或结论，请基于提供的真人消息统计和归纳；如果记录不足，要说明“基于最近聊天记录”。",
		"回答要直接、简洁，不要复述整段聊天记录，除非用户明确要求。",
	}, "\n")
	var user strings.Builder
	user.WriteString("最近聊天记录：\n")
	user.WriteString(contextText)
	user.WriteString("\n\n用户本次@小A的问题：\n")
	user.WriteString(triggerText)
	if quotedText != "" {
		user.WriteString("\n\n被引用/重点消息：\n")
		user.WriteString(quotedText)
	}
	if taskPayload != nil {
		user.WriteString("\n\n任务来源：群聊@小A。")
	}
	return []provider.Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user.String()},
	}, nil
}

func (s *Service) loadChatContextTrigger(ctx context.Context, conversationID int64, triggerMessageID int64) (chatContextMessage, int64, error) {
	var item chatContextMessage
	var contentPayload string
	var contentPreview string
	var quoteID int64
	err := s.db.QueryRow(ctx, `
		SELECT id, seq_no, sender_username, message_type, content_payload, content_preview, COALESCE(reply_to_message_id, 0)
		FROM im_message
		WHERE conversation_id = $1 AND id = $2 AND deleted_at IS NULL`, conversationID, triggerMessageID).
		Scan(&item.ID, &item.SeqNo, &item.Sender, &item.MessageType, &contentPayload, &contentPreview, &quoteID)
	if err != nil {
		return chatContextMessage{}, 0, err
	}
	item.Sender = strings.ToLower(strings.TrimSpace(item.Sender))
	item.Content = legacyAIMessageContent(item.MessageType, contentPayload, contentPreview)
	item.IsTrigger = true
	return item, quoteID, nil
}

func (s *Service) loadRecentHumanChatContext(ctx context.Context, conversationID int64, maxSeqNo int64, triggerMessageID int64, quoteID int64, cfg RuntimeConfig) ([]chatContextMessage, error) {
	limit := cfg.ChatContextMaxMessages
	if limit <= 0 {
		limit = defaultChatContextMaxMessages
	}
	tokenBudget := cfg.ChatContextMaxTokens
	if tokenBudget <= 0 {
		tokenBudget = defaultChatContextMaxTokens
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, seq_no, sender_username, message_type, content_payload, content_preview
		FROM im_message
		WHERE conversation_id = $1
		  AND deleted_at IS NULL
		  AND seq_no <= $2
		ORDER BY seq_no DESC
		LIMIT $3`, conversationID, maxSeqNo, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	newestFirst := make([]chatContextMessage, 0, limit)
	usedTokens := 0
	for rows.Next() {
		var item chatContextMessage
		var contentPayload string
		var contentPreview string
		if err := rows.Scan(&item.ID, &item.SeqNo, &item.Sender, &item.MessageType, &contentPayload, &contentPreview); err != nil {
			return nil, err
		}
		item.Sender = strings.ToLower(strings.TrimSpace(item.Sender))
		if !isHumanChatContextSender(item.Sender) {
			continue
		}
		item.Content = strings.TrimSpace(legacyAIMessageContent(item.MessageType, contentPayload, contentPreview))
		if item.Content == "" {
			continue
		}
		item.IsTrigger = item.ID == triggerMessageID
		item.IsQuotedFocus = quoteID > 0 && item.ID == quoteID
		item.Content = truncateToEstimatedTokens(item.Content, 900)
		tokens := estimateTextTokens(item.Content) + 16
		if usedTokens+tokens > tokenBudget && !item.IsTrigger && !item.IsQuotedFocus {
			continue
		}
		newestFirst = append(newestFirst, item)
		usedTokens += tokens
		if usedTokens >= tokenBudget && hasTriggerAndQuote(newestFirst, triggerMessageID, quoteID) {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if quoteID > 0 && !containsContextMessage(newestFirst, quoteID) {
		if quoted, err := s.loadSingleHumanChatContextMessage(ctx, conversationID, quoteID); err == nil {
			quoted.IsQuotedFocus = true
			newestFirst = append(newestFirst, quoted)
		} else {
			log.Printf("AI quoted context message load failed: conversation_id=%d message_id=%d err=%v", conversationID, quoteID, err)
		}
	}
	for left, right := 0, len(newestFirst)-1; left < right; left, right = left+1, right-1 {
		newestFirst[left], newestFirst[right] = newestFirst[right], newestFirst[left]
	}
	return newestFirst, nil
}

func (s *Service) loadSingleHumanChatContextMessage(ctx context.Context, conversationID int64, messageID int64) (chatContextMessage, error) {
	var item chatContextMessage
	var contentPayload string
	var contentPreview string
	err := s.db.QueryRow(ctx, `
		SELECT id, seq_no, sender_username, message_type, content_payload, content_preview
		FROM im_message
		WHERE conversation_id = $1 AND id = $2 AND deleted_at IS NULL`, conversationID, messageID).
		Scan(&item.ID, &item.SeqNo, &item.Sender, &item.MessageType, &contentPayload, &contentPreview)
	if err != nil {
		return chatContextMessage{}, err
	}
	item.Sender = strings.ToLower(strings.TrimSpace(item.Sender))
	if !isHumanChatContextSender(item.Sender) {
		return chatContextMessage{}, fmt.Errorf("quoted message is AI generated")
	}
	item.Content = truncateToEstimatedTokens(legacyAIMessageContent(item.MessageType, contentPayload, contentPreview), 900)
	return item, nil
}

func isHumanChatContextSender(sender string) bool {
	sender = strings.ToLower(strings.TrimSpace(sender))
	return sender != "" && !bot.IsBotUsername(sender)
}

func hasTriggerAndQuote(items []chatContextMessage, triggerMessageID int64, quoteID int64) bool {
	hasTrigger := triggerMessageID <= 0
	hasQuote := quoteID <= 0
	for _, item := range items {
		if item.ID == triggerMessageID {
			hasTrigger = true
		}
		if item.ID == quoteID {
			hasQuote = true
		}
	}
	return hasTrigger && hasQuote
}

func containsContextMessage(items []chatContextMessage, messageID int64) bool {
	for _, item := range items {
		if item.ID == messageID {
			return true
		}
	}
	return false
}

func (s *Service) enrichChatContextDisplayNames(ctx context.Context, items []chatContextMessage) {
	if s == nil || s.db == nil || len(items) == 0 {
		return
	}
	usernames := make([]string, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		if item.Sender == "" {
			continue
		}
		if _, ok := seen[item.Sender]; ok {
			continue
		}
		seen[item.Sender] = struct{}{}
		usernames = append(usernames, item.Sender)
	}
	if len(usernames) == 0 {
		return
	}
	rows, err := s.db.Query(ctx, `
		SELECT input.username,
		       COALESCE(NULLIF(p.nickname, ''), NULLIF(us.real_name, ''), input.username) AS display_name
		FROM unnest($1::text[]) AS input(username)
		LEFT JOIN im_user_profile p ON p.username = input.username
		LEFT JOIN user_stats us ON us.username = input.username`, usernames)
	if err != nil {
		log.Printf("AI chat context display name load failed: count=%d err=%v", len(usernames), err)
		return
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var username string
		var displayName string
		if err := rows.Scan(&username, &displayName); err != nil {
			return
		}
		username = strings.ToLower(strings.TrimSpace(username))
		displayName = strings.TrimSpace(displayName)
		if username != "" && displayName != "" {
			names[username] = displayName
		}
	}
	for index := range items {
		if name := names[items[index].Sender]; name != "" {
			items[index].DisplayName = name
		}
	}
}

func renderChatContextTranscript(items []chatContextMessage) string {
	var builder strings.Builder
	for _, item := range items {
		content := strings.TrimSpace(item.Content)
		if content == "" {
			continue
		}
		markers := make([]string, 0, 2)
		if item.IsQuotedFocus {
			markers = append(markers, "引用重点")
		}
		if item.IsTrigger {
			markers = append(markers, "本次@小A")
		}
		markerText := ""
		if len(markers) > 0 {
			markerText = " [" + strings.Join(markers, " / ") + "]"
		}
		builder.WriteString(fmt.Sprintf("[%d]%s %s(@%s)：%s\n", item.SeqNo, markerText, displayNameOrUsername(item), item.Sender, content))
	}
	return strings.TrimSpace(builder.String())
}

func displayNameOrUsername(item chatContextMessage) string {
	if strings.TrimSpace(item.DisplayName) != "" {
		return strings.TrimSpace(item.DisplayName)
	}
	return strings.TrimSpace(item.Sender)
}

func cleanBotMentionText(value string) string {
	text := strings.TrimSpace(strings.NewReplacer("＠", "@", "\u200b", "", "\u200c", "", "\u200d", "", "\ufeff", "").Replace(value))
	replacements := []string{"@小A", "@小a", "@AK助手", "@ak助手", "@AI助手", "@ai助手", "@ak_ai_assistant"}
	for _, old := range replacements {
		text = strings.ReplaceAll(text, old, "")
	}
	return strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
}
