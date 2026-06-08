package app

import (
	"testing"
	"time"
)

func TestBuildCallOutcomePayloadTimeout(t *testing.T) {
	session := &imCallSession{
		CallID:         "call_timeout",
		ConversationID: 12,
		CallerUsername: "alice",
		CalleeUsername: "bob",
		CallKind:       "audio",
	}

	payload := buildCallOutcomePayload(session, "timeout", "alice", "caller")
	if payload.Event != "cancelled" {
		t.Fatalf("Event = %q, want cancelled", payload.Event)
	}
	if payload.Reason != "timeout" {
		t.Fatalf("Reason = %q, want timeout", payload.Reason)
	}
	if preview := buildCallOutcomePreview(payload); preview != "语音通话 未接通" {
		t.Fatalf("preview = %q", preview)
	}
}

func TestBuildCallOutcomePayloadRejected(t *testing.T) {
	session := &imCallSession{
		CallID:         "call_rejected",
		ConversationID: 12,
		CallerUsername: "alice",
		CalleeUsername: "bob",
		CallKind:       "video",
	}

	payload := buildCallOutcomePayload(session, "rejected", "bob", "callee")
	if payload.Event != "rejected" {
		t.Fatalf("Event = %q, want rejected", payload.Event)
	}
	if payload.Actor != "bob" || payload.ActorRole != "callee" {
		t.Fatalf("actor = %q/%q, want bob/callee", payload.Actor, payload.ActorRole)
	}
	if preview := buildCallOutcomePreview(payload); preview != "视频通话 已拒接" {
		t.Fatalf("preview = %q", preview)
	}
}

func TestBuildCallOutcomePayloadCompletedDuration(t *testing.T) {
	start := time.Date(2026, 6, 8, 10, 0, 0, 0, time.Local)
	session := &imCallSession{
		CallID:         "call_completed",
		ConversationID: 12,
		CallerUsername: "alice",
		CalleeUsername: "bob",
		CallKind:       "audio",
		ConnectedAt:    start,
		EndedAt:        start.Add(75 * time.Second),
	}

	payload := buildCallOutcomePayload(session, "hangup", "alice", "caller")
	if payload.Event != "completed" {
		t.Fatalf("Event = %q, want completed", payload.Event)
	}
	if payload.DurationSeconds != 75 || payload.DurationText != "01:15" {
		t.Fatalf("duration = %d/%q, want 75/01:15", payload.DurationSeconds, payload.DurationText)
	}
	if preview := buildCallOutcomePreview(payload); preview != "语音通话 通话时长 01:15" {
		t.Fatalf("preview = %q", preview)
	}
}
