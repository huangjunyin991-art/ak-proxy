package service

import "testing"

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
