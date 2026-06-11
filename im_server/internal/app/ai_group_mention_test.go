package app

import "testing"

func TestTextMentionsBot(t *testing.T) {
	tests := []struct {
		name        string
		messageType string
		content     string
		want        bool
	}{
		{name: "small a", messageType: "text", content: "\u5e2e\u6211\u770b\u770b @\u5c0fA", want: true},
		{name: "fullwidth at", messageType: "text", content: "\u5e2e\u6211\u770b\u770b \uff20AI\u52a9\u624b", want: true},
		{name: "technical username", messageType: "text", content: "@ak_ai_assistant summarize", want: true},
		{name: "normal text", messageType: "text", content: "\u8fd9\u662f\u666e\u901a\u6d88\u606f", want: false},
		{name: "non text", messageType: "image", content: "@\u5c0fA", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := textMentionsBot(tt.messageType, tt.content); got != tt.want {
				t.Fatalf("textMentionsBot() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAppendAIVirtualMember(t *testing.T) {
	items := appendAIVirtualMember([]SessionMemberItem{{Username: "alice", DisplayName: "Alice"}})
	if len(items) != 2 {
		t.Fatalf("expected virtual AI member appended, got %d items", len(items))
	}
	if items[1].Username != "ak_ai_assistant" || items[1].Role != "ai" {
		t.Fatalf("unexpected virtual AI member: %+v", items[1])
	}
	items = appendAIVirtualMember(items)
	if len(items) != 2 {
		t.Fatalf("virtual AI member should not be duplicated, got %d items", len(items))
	}
}
