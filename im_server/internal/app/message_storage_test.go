package app

import "testing"

func TestBuildMessageStoragePreservesTextParagraphs(t *testing.T) {
	content := "first paragraph\n\n\nsecond paragraph\n  third paragraph"

	messageType, preview, payload, rawSize, storedSize, err := buildMessageStorage(sendMessageRequest{
		MessageType: "text",
		Content:     content,
	})
	if err != nil {
		t.Fatalf("buildMessageStorage returned error: %v", err)
	}
	if messageType != "text" {
		t.Fatalf("messageType = %q, want text", messageType)
	}
	if payload != content {
		t.Fatalf("payload = %q, want original content with paragraph breaks", payload)
	}
	if preview != "first paragraph second paragraph third paragraph" {
		t.Fatalf("preview = %q, want single-line preview", preview)
	}
	if rawSize != len(content) || storedSize != len(content) {
		t.Fatalf("sizes = %d/%d, want %d", rawSize, storedSize, len(content))
	}
}

func TestBuildMessageStorageTrimsOuterTextOnly(t *testing.T) {
	content := "  first paragraph\n\nsecond paragraph  "

	_, _, payload, _, _, err := buildMessageStorage(sendMessageRequest{
		MessageType: "text",
		Content:     content,
	})
	if err != nil {
		t.Fatalf("buildMessageStorage returned error: %v", err)
	}
	if payload != "first paragraph\n\nsecond paragraph" {
		t.Fatalf("payload = %q, want only outer whitespace trimmed", payload)
	}
}
