package service

import "testing"

func TestLegacyAIMessageContentPrefersTextPayload(t *testing.T) {
	got := legacyAIMessageContent("text", "真正内容", "预览")
	if got != "真正内容" {
		t.Fatalf("legacyAIMessageContent = %q, want text payload", got)
	}
}

func TestLegacyAIMessageContentFallsBackToPreview(t *testing.T) {
	got := legacyAIMessageContent("image", `{"url":"hidden"}`, "[图片]")
	if got != "[图片]" {
		t.Fatalf("legacyAIMessageContent = %q, want preview", got)
	}
}

func TestLegacyAIMessageContentUsesNonTextPlaceholder(t *testing.T) {
	got := legacyAIMessageContent("image", "", "")
	if got != "[非文本消息]" {
		t.Fatalf("legacyAIMessageContent = %q, want placeholder", got)
	}
}

func TestAIMessageVersionGroupHelpers(t *testing.T) {
	if got := sourceMessageVersionGroup("User", 123); got != "im_user_123" {
		t.Fatalf("sourceMessageVersionGroup = %q", got)
	}
	if got := assistantAnswerVersionGroup(456); got != "ai_answer_456" {
		t.Fatalf("assistantAnswerVersionGroup = %q", got)
	}
	if got := assistantAnswerVersionGroup(0); got != "ai_answer_orphan" {
		t.Fatalf("assistantAnswerVersionGroup orphan = %q", got)
	}
}
