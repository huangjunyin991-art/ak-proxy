package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im_server/internal/ai/bot"
	"im_server/internal/ai/provider"
	aiservice "im_server/internal/ai/service"
	"im_server/internal/entitlement"

	"github.com/jackc/pgx/v5"
)

type aiRedeemRequest struct {
	Code string `json:"code"`
}

type aiProviderSecretRequest struct {
	Secret string `json:"secret"`
}

func (a *App) handleAIRoutes(w http.ResponseWriter, r *http.Request) {
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/im/api/ai")
	if path == "" {
		path = "/"
	}
	switch {
	case path == "/bootstrap" && r.Method == http.MethodGet:
		a.handleAIBootstrap(w, r, username)
	case path == "/session" && r.Method == http.MethodPost:
		a.handleAISession(w, r, username)
	case path == "/redeem" && r.Method == http.MethodPost:
		a.handleAIRedeem(w, r, username)
	case strings.HasPrefix(path, "/tasks/") && r.Method == http.MethodGet:
		taskID := strings.Trim(strings.TrimPrefix(path, "/tasks/"), "/")
		a.handleAITask(w, r, username, taskID)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "AI API not found"})
	}
}

func (a *App) handleAIBootstrap(w http.ResponseWriter, r *http.Request, username string) {
	if a.ai == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "available": false})
		return
	}
	item, err := a.ai.Bootstrap(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *App) handleAISession(w http.ResponseWriter, r *http.Request, username string) {
	if a.ai == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "AI service is not available"})
		return
	}
	conversationID, err := a.ensureDirectConversation(r.Context(), username, bot.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := a.ai.EnsureConversation(r.Context(), username, conversationID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	bootstrap, _ := a.ai.Bootstrap(r.Context(), username)
	writeJSON(w, http.StatusOK, map[string]any{
		"conversation_id":  conversationID,
		"bot_username":     bot.Username,
		"bot_display_name": bot.DisplayName,
		"bootstrap":        bootstrap,
	})
}

func (a *App) handleAIRedeem(w http.ResponseWriter, r *http.Request, username string) {
	if a.entitlements == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "AI entitlement service is not available"})
		return
	}
	var req aiRedeemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	result, err := a.entitlements.Redeem(r.Context(), username, req.Code, requestIP(r), r.UserAgent())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) handleAITask(w http.ResponseWriter, r *http.Request, username string, taskID string) {
	if a.ai == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": true, "message": "AI service is not available"})
		return
	}
	item, err := a.ai.Task(r.Context(), taskID, username)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "task not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func requestIP(r *http.Request) string {
	for _, key := range []string{"X-Real-IP", "X-Forwarded-For"} {
		value := strings.TrimSpace(r.Header.Get(key))
		if value == "" {
			continue
		}
		if key == "X-Forwarded-For" {
			value = strings.TrimSpace(strings.Split(value, ",")[0])
		}
		if value != "" {
			return value
		}
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func (a *App) handleAIAdminRoutes(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/im/internal/ai/admin")
	if path == "" {
		path = "/"
	}
	parts := splitPath(path)
	switch {
	case len(parts) == 1 && parts[0] == "diagnostics" && r.Method == http.MethodGet:
		a.handleAIAdminDiagnostics(w, r)
	case len(parts) == 1 && parts[0] == "config" && r.Method == http.MethodGet:
		item, err := a.ai.Config(r.Context())
		writeJSONOrError(w, item, err)
	case len(parts) == 1 && parts[0] == "config" && r.Method == http.MethodPost:
		var req aiservice.RuntimeConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.ai.SetConfig(r.Context(), req)
		writeJSONOrError(w, item, err)
	case len(parts) == 1 && parts[0] == "providers" && r.Method == http.MethodGet:
		items, err := a.aiProvider.ListAccounts(r.Context())
		writeJSONOrError(w, items, err)
	case len(parts) == 1 && parts[0] == "providers" && r.Method == http.MethodPost:
		var req provider.Account
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.aiProvider.UpsertAccount(r.Context(), req)
		writeJSONOrError(w, item, err)
	case len(parts) == 2 && parts[0] == "providers" && r.Method == http.MethodPut:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid provider id"})
			return
		}
		var req provider.Account
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		req.ID = id
		item, err := a.aiProvider.UpsertAccount(r.Context(), req)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "providers" && parts[2] == "secret" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid provider id"})
			return
		}
		var req aiProviderSecretRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.aiProvider.SetSecret(r.Context(), id, req.Secret)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "providers" && parts[2] == "test" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid provider id"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := a.aiProvider.Test(ctx, id)
		writeJSONOrError(w, result, err)
	case len(parts) == 4 && parts[0] == "providers" && parts[2] == "balance" && parts[3] == "refresh" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid provider id"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		item, err := a.aiProvider.RefreshBalance(ctx, id)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "providers" && parts[2] == "balance" && r.Method == http.MethodGet:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid provider id"})
			return
		}
		item, err := a.aiProvider.GetBalance(r.Context(), id)
		writeJSONOrError(w, item, err)
	case len(parts) == 1 && parts[0] == "tiers" && r.Method == http.MethodGet:
		items, err := a.entitlements.ListTierConfigs(r.Context())
		writeJSONOrError(w, items, err)
	case len(parts) == 1 && parts[0] == "tiers" && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		var req entitlement.TierConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.entitlements.UpsertTierConfig(r.Context(), req)
		writeJSONOrError(w, item, err)
	case len(parts) == 1 && parts[0] == "redeem-codes" && r.Method == http.MethodGet:
		items, err := a.entitlements.ListRedeemCodes(r.Context(), 200)
		writeJSONOrError(w, items, err)
	case len(parts) == 1 && parts[0] == "redeem-codes" && r.Method == http.MethodPost:
		var req entitlement.RedeemCodeCreateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		items, err := a.entitlements.CreateRedeemCodes(r.Context(), req)
		writeJSONOrError(w, items, err)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "AI admin API not found"})
	}
}

func (a *App) handleAIAdminDiagnostics(w http.ResponseWriter, r *http.Request) {
	if a.ai == nil || a.aiProvider == nil || a.entitlements == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"item": map[string]any{
				"available": false,
				"message":   "AI services are not initialized",
			},
		})
		return
	}
	cfg, cfgErr := a.ai.Config(r.Context())
	providers, providersErr := a.aiProvider.ListAccounts(r.Context())
	activeProviderID := int64(0)
	activeProviderName := ""
	activeProviderHasSecret := false
	for _, item := range providers {
		if !item.Enabled {
			continue
		}
		activeProviderID = item.ID
		activeProviderName = item.ProviderName
		activeProviderHasSecret = strings.TrimSpace(item.SecretFingerprint) != ""
		break
	}
	providerReady := false
	providerMessage := ""
	if _, _, err := a.aiProvider.LoadActiveAccount(r.Context()); err != nil {
		providerMessage = err.Error()
	} else {
		providerReady = true
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"item": map[string]any{
			"available":                  cfgErr == nil && providersErr == nil && providerReady && cfg.Enabled,
			"enabled":                    cfg.Enabled,
			"config_error":               errorString(cfgErr),
			"provider_error":             errorString(providersErr),
			"provider_ready":             providerReady,
			"provider_message":           providerMessage,
			"provider_count":             len(providers),
			"active_provider_id":         activeProviderID,
			"active_provider_name":       activeProviderName,
			"active_provider_has_secret": activeProviderHasSecret,
			"queue_concurrency":          a.ai.QueueConcurrency(),
		},
	})
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func splitPath(path string) []string {
	raw := strings.Split(strings.Trim(path, "/"), "/")
	parts := make([]string, 0, len(raw))
	for _, item := range raw {
		item = strings.TrimSpace(item)
		if item != "" {
			parts = append(parts, item)
		}
	}
	return parts
}

func parseID(value string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid id")
	}
	return id, nil
}

func writeJSONOrError(w http.ResponseWriter, payload any, err error) {
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "item": payload})
}

func (a *App) InsertAITextMessage(ctx context.Context, conversationID int64, senderUsername string, content string) (aiservice.MessageRef, error) {
	item, err := a.insertSystemTextMessage(ctx, conversationID, senderUsername, content)
	if err != nil {
		return aiservice.MessageRef{}, err
	}
	a.broadcastMessageCreated(ctx, conversationID, item)
	return aiservice.MessageRef{
		ID:             item.ID,
		ConversationID: item.ConversationID,
		SenderUsername: item.SenderUsername,
		Content:        item.Content,
	}, nil
}

func (a *App) insertSystemTextMessage(ctx context.Context, conversationID int64, senderUsername string, content string) (MessageItem, error) {
	messageType, preview, contentPayload, contentSizeRaw, contentSizeStored, err := buildMessageStorage(sendMessageRequest{
		ConversationID: conversationID,
		MessageType:    "text",
		Content:        content,
	})
	if err != nil {
		return MessageItem{}, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return MessageItem{}, err
	}
	defer tx.Rollback(ctx)
	nextSeqNo, err := a.allocateMessageSeqNoTx(ctx, tx, conversationID)
	if err != nil {
		return MessageItem{}, err
	}
	var item MessageItem
	var sentAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO im_message (conversation_id, sender_username, seq_no, message_type, content_preview, content_payload, content_size_raw, content_size_stored, sent_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, timezone('Asia/Shanghai', NOW()))
		RETURNING id, conversation_id, sender_username, seq_no, message_type, content_payload, content_preview, status, sent_at`,
		conversationID, strings.ToLower(strings.TrimSpace(senderUsername)), nextSeqNo, messageType, preview, contentPayload, contentSizeRaw, contentSizeStored,
	).Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt)
	if err != nil {
		return MessageItem{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE im_conversation SET last_message_id = $1, last_message_preview = $2, last_message_at = timezone('Asia/Shanghai', NOW()), updated_at = NOW() WHERE id = $3`, item.ID, item.ContentPreview, conversationID); err != nil {
		return MessageItem{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE im_direct_message_gate
		SET reply_unlocked_at = COALESCE(reply_unlocked_at, NOW()), updated_at = NOW()
		WHERE conversation_id = $1`, conversationID); err != nil {
		return MessageItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MessageItem{}, err
	}
	item.SentAt = formatIMTimestamp(sentAt)
	senderIdentity := a.buildUserIdentityItem(ctx, item.SenderUsername)
	item.SenderDisplayName = senderIdentity.DisplayName
	item.SenderHonorName = senderIdentity.HonorName
	item.SenderAvatarKind = senderIdentity.AvatarKind
	item.SenderAvatarStyle = senderIdentity.AvatarStyle
	item.SenderAvatarSeed = senderIdentity.AvatarSeed
	item.SenderAvatarURL = senderIdentity.AvatarURL
	item = a.normalizeOutgoingMessageItem(ctx, item)
	return item, nil
}
