package app

import (
	"errors"
	"testing"
)

func TestBuildMessageStoragePreservesTextParagraphs(t *testing.T) {
	content := "  first paragraph\n\n\nsecond paragraph\n  third paragraph  "

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

func TestBuildMessageStorageRejectsWhitespaceOnlyText(t *testing.T) {
	_, _, _, _, _, err := buildMessageStorage(sendMessageRequest{
		MessageType: "text",
		Content:     " \n\t\r\n ",
	})
	if err == nil {
		t.Fatal("buildMessageStorage returned nil error for whitespace-only content")
	}
	if !errors.Is(err, errEmptyMessageContent) {
		t.Fatalf("error = %v, want errEmptyMessageContent", err)
	}
}

func TestBuildMessageStorageNormalizesTextLineEndings(t *testing.T) {
	_, _, payload, _, _, err := buildMessageStorage(sendMessageRequest{
		MessageType: "text",
		Content:     "first\r\n\rsecond",
	})
	if err != nil {
		t.Fatalf("buildMessageStorage returned error: %v", err)
	}
	if payload != "first\n\nsecond" {
		t.Fatalf("payload = %q, want normalized line endings", payload)
	}
}

func TestIsAvatarImageStorageName(t *testing.T) {
	valid := "avatar_4fedbe4ad7684b30705de0bd33cb6cab0ac3849414483cfd166b05836fa74b54.webp"
	if !isAvatarImageStorageName(valid) {
		t.Fatalf("isAvatarImageStorageName(%q) = false, want true", valid)
	}

	invalidNames := []string{
		"image_4fedbe4ad7684b30705de0bd33cb6cab0ac3849414483cfd166b05836fa74b54.webp",
		"avatar_4fedbe4ad7684b30705de0bd33cb6cab0ac3849414483cfd166b05836fa74b54.jpg",
		"avatar_4fedbe4ad7684b30705de0bd33cb6cab0ac3849414483cfd166b05836fa74b5.webp",
		"avatar_4fedbe4ad7684b30705de0bd33cb6cab0ac3849414483cfd166b05836fa74b5x.webp",
		"avatar_4FEDBE4AD7684B30705DE0BD33CB6CAB0AC3849414483CFD166B05836FA74B54.webp",
	}
	for _, storageName := range invalidNames {
		if isAvatarImageStorageName(storageName) {
			t.Fatalf("isAvatarImageStorageName(%q) = true, want false", storageName)
		}
	}
}
