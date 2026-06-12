package service

import (
	"strings"
	"testing"

	"im_server/internal/ai/bot"
)

func TestIsGroupMentionTask(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    bool
	}{
		{name: "action", payload: map[string]any{"action": groupMentionAction}, want: true},
		{name: "context mode", payload: map[string]any{"context_mode": "conversation_mention"}, want: true},
		{name: "direct chat", payload: map[string]any{"action": "reply"}, want: false},
		{name: "nil", payload: nil, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isGroupMentionTask(tt.payload); got != tt.want {
				t.Fatalf("isGroupMentionTask() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHumanChatContextSenderExcludesAIGeneratedMessages(t *testing.T) {
	if isHumanChatContextSender(bot.Username) {
		t.Fatalf("bot username should be excluded from chat context")
	}
	if isHumanChatContextSender("  AK_AI_ASSISTANT  ") {
		t.Fatalf("bot username should be normalized before exclusion")
	}
	if !isHumanChatContextSender("alice") {
		t.Fatalf("normal user should be kept in chat context")
	}
	if isHumanChatContextSender("") {
		t.Fatalf("empty sender should not enter chat context")
	}
}

func TestQuotedChatContextSenderAllowsAIGeneratedMessage(t *testing.T) {
	if shouldIncludeChatContextSender(bot.Username, false) {
		t.Fatalf("bot username should still be excluded from normal mention context")
	}
	if !shouldIncludeChatContextSender(bot.Username, true) {
		t.Fatalf("quoted bot message should be allowed as focused context")
	}
	if shouldIncludeChatContextSender("", true) {
		t.Fatalf("empty sender should never enter chat context")
	}
	if !shouldIncludeChatContextSender("alice", false) {
		t.Fatalf("normal user should be kept in normal context")
	}
}

func TestCleanBotMentionText(t *testing.T) {
	got := cleanBotMentionText("\u200b@\u5c0fA \u5e2e\u6211\u603b\u7ed3\u4e00\u4e0b")
	if strings.Contains(got, "@") || strings.Contains(got, "\u5c0fA") {
		t.Fatalf("mention marker should be removed, got %q", got)
	}
	if got != "\u5e2e\u6211\u603b\u7ed3\u4e00\u4e0b" {
		t.Fatalf("unexpected cleaned text: %q", got)
	}
}
