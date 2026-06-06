package app

import (
	"context"
	"fmt"
	"strings"
)

func (a *App) notifyCallInvitation(ctx context.Context, session *imCallSession) {
	if a == nil || a.messageNotifier == nil || session == nil {
		return
	}
	callID := strings.TrimSpace(session.CallID)
	callee := normalizeCallUsername(session.CalleeUsername)
	caller := normalizeCallUsername(session.CallerUsername)
	if callID == "" || caller == "" || callee == "" || session.ConversationID <= 0 {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	callerDisplayName := a.resolveCallNotifyDisplayName(ctx, caller)
	event := map[string]any{
		"event_id":            fmt.Sprintf("im-call:%s:invite", callID),
		"event_type":          "im.call.invite",
		"message_id":          0,
		"message_type":        "call_invite",
		"conversation_id":     session.ConversationID,
		"conversation_type":   "direct",
		"call_id":             callID,
		"call_kind":           normalizeCallKind(session.CallKind),
		"sender_username":     caller,
		"sender_display_name": callerDisplayName,
		"caller_username":     caller,
		"callee_username":     callee,
		"recipient_usernames": []string{callee},
		"sent_at":             session.CreatedAt,
	}
	a.messageNotifier.Publish(ctx, event)
}

func (a *App) resolveCallNotifyDisplayName(ctx context.Context, username string) string {
	normalized := normalizeCallUsername(username)
	if normalized == "" {
		return ""
	}
	identity := a.buildUserIdentityItem(ctx, normalized)
	displayName := strings.TrimSpace(identity.DisplayName)
	if displayName != "" {
		return displayName
	}
	return normalized
}
