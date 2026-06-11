package service

import (
	"strings"
	"testing"
)

func TestIsContinueOnlyPrompt(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{name: "plain continue", text: "\u7ee7\u7eed", want: true},
		{name: "continue with punctuation", text: " \u7ee7\u7eed\uff1f ", want: true},
		{name: "continue speaking", text: "\u63a5\u7740\u8bf4\uff01", want: true},
		{name: "english continue", text: "continue", want: true},
		{name: "normal message", text: "\u4f60\u597d", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isContinueOnlyPrompt(tt.text); got != tt.want {
				t.Fatalf("isContinueOnlyPrompt(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestIsModelIdentityQuestion(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{name: "plain chinese", text: "你是什么模型", want: true},
		{name: "chinese with punctuation", text: "你当前用的是什么模型？", want: true},
		{name: "gpt question", text: "你是 GPT 吗", want: true},
		{name: "english model", text: "what model are you?", want: true},
		{name: "normal chat", text: "帮我写一个登录页", want: false},
		{name: "model comparison", text: "帮我整理主流AI模型产品对比", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isModelIdentityQuestion(tt.text); got != tt.want {
				t.Fatalf("isModelIdentityQuestion(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestModelIdentityRefusalReply(t *testing.T) {
	if modelIdentityRefusalReply != "我无法回答这个话题，让我们换个话题吧~" {
		t.Fatalf("unexpected model identity refusal reply: %q", modelIdentityRefusalReply)
	}
}

func TestIsGenericAIRefusal(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{name: "cannot answer", text: "\u60a8\u7684\u95ee\u9898\u6211\u65e0\u6cd5\u56de\u7b54\u3002", want: true},
		{name: "no related content", text: "\u4f60\u597d\uff0c\u6211\u65e0\u6cd5\u7ed9\u5230\u76f8\u5173\u5185\u5bb9\u3002", want: true},
		{name: "no related result", text: "\u62b1\u6b49\uff0c\u8fd9\u4e2a\u95ee\u9898\u672a\u627e\u5230\u76f8\u5173\u7ed3\u679c\u3002", want: true},
		{name: "normal empathy", text: "\u6211\u7406\u89e3\u4f60\u73b0\u5728\u5f88\u751f\u6c14\uff0c\u5148\u522b\u6025\u7740\u56de\u590d\u5bf9\u65b9\u3002", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isGenericAIRefusal(tt.text); got != tt.want {
				t.Fatalf("isGenericAIRefusal(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestBuildChatSystemPromptCleansRefusalMemory(t *testing.T) {
	prompt := buildChatSystemPrompt("\u60a8\u7684\u95ee\u9898\u6211\u65e0\u6cd5\u56de\u7b54\u3002\n\u7528\u6237\u559c\u6b22\u7b80\u6d01\u76f4\u63a5\u7684\u56de\u7b54\u3002", RuntimeConfig{})
	if strings.Contains(prompt, "\u60a8\u7684\u95ee\u9898\u6211\u65e0\u6cd5\u56de\u7b54") {
		t.Fatalf("prompt should filter generic refusal memory: %s", prompt)
	}
	if !strings.Contains(prompt, "\u7528\u6237\u559c\u6b22\u7b80\u6d01\u76f4\u63a5\u7684\u56de\u7b54") {
		t.Fatalf("prompt should keep useful memory: %s", prompt)
	}
	if !strings.Contains(prompt, "normal conversational chat") {
		t.Fatalf("prompt should clarify normal chat behavior: %s", prompt)
	}
}
