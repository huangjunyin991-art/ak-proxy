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

	"im_server/internal/ai/billing"
	"im_server/internal/ai/bot"
	"im_server/internal/ai/provider"
	"im_server/internal/ai/relayconsole"
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

type aiProviderTestRequest struct {
	Prompt string `json:"prompt"`
	Model  string `json:"model"`
}

type aiRelayConsoleSyncRequest struct {
	TokenID string `json:"token_id"`
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
	case len(parts) == 2 && parts[0] == "billing" && parts[1] == "config" && r.Method == http.MethodGet:
		item, err := a.aiBilling.Config(r.Context())
		writeJSONOrError(w, item, err)
	case len(parts) == 2 && parts[0] == "billing" && parts[1] == "config" && r.Method == http.MethodPost:
		var req billing.Config
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.aiBilling.SetConfig(r.Context(), req)
		writeJSONOrError(w, item, err)
	case len(parts) == 2 && parts[0] == "billing" && parts[1] == "overview" && r.Method == http.MethodGet:
		item, err := a.aiBilling.Overview(r.Context(), 30)
		writeJSONOrError(w, item, err)
	case len(parts) == 1 && parts[0] == "relay-consoles" && r.Method == http.MethodGet:
		item, err := a.aiRelayConsole.Status(r.Context())
		writeJSONOrError(w, item, err)
	case len(parts) == 1 && parts[0] == "relay-consoles" && r.Method == http.MethodPost:
		var req relayconsole.Account
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.aiRelayConsole.UpsertAccount(r.Context(), req)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "relay-consoles" && parts[2] == "credentials" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid relay console id"})
			return
		}
		var req relayconsole.CredentialsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.aiRelayConsole.SetCredentials(r.Context(), id, req)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "relay-consoles" && parts[2] == "login" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid relay console id"})
			return
		}
		item, err := a.aiRelayConsole.Login(r.Context(), id)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "relay-consoles" && parts[2] == "tokens" && r.Method == http.MethodGet:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid relay console id"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		item, err := a.aiRelayConsole.ListTokens(ctx, id)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "relay-consoles" && parts[2] == "sync" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid relay console id"})
			return
		}
		var req aiRelayConsoleSyncRequest
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&req)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		item, err := a.aiRelayConsole.Sync(ctx, id, req.TokenID)
		writeJSONOrError(w, item, err)
	case len(parts) == 3 && parts[0] == "relay-consoles" && parts[2] == "import-provider" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid relay console id"})
			return
		}
		var req relayconsole.ImportProviderRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		req.ConsoleID = id
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		item, err := a.importRelayConsoleTokenAsProvider(ctx, req)
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
		var req aiProviderTestRequest
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&req)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := a.aiProvider.Test(ctx, id, req.Prompt, req.Model)
		writeJSONOrError(w, result, err)
	case len(parts) == 3 && parts[0] == "providers" && parts[2] == "models" && r.Method == http.MethodPost:
		id, err := parseID(parts[1])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid provider id"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		models, err := a.aiProvider.RefreshModels(ctx, id)
		writeJSONOrError(w, map[string]any{"models": models}, err)
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
	billingOverview, billingErr := a.aiBilling.Overview(r.Context(), 5)
	relayStatus, relayErr := a.aiRelayConsole.Status(r.Context())
	relayBalance := float64(0)
	relayLowBalance := false
	if relayStatus.LatestBalance != nil {
		relayBalance = relayStatus.LatestBalance.TotalAvailable
		relayLowBalance = relayStatus.LatestBalance.LowBalance
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
			"billing_enabled":            billingErr == nil && billingOverview.Config.Enabled,
			"billing_error":              errorString(billingErr),
			"billing_today_units":        billingOverview.TodayUnits,
			"billing_month_units":        billingOverview.MonthUnits,
			"relay_console_count":        len(relayStatus.Accounts),
			"relay_console_error":        errorString(relayErr),
			"relay_console_balance":      relayBalance,
			"relay_console_low_balance":  relayLowBalance,
		},
	})
}

func (a *App) importRelayConsoleTokenAsProvider(ctx context.Context, req relayconsole.ImportProviderRequest) (provider.Account, error) {
	if a.aiRelayConsole == nil || a.aiProvider == nil {
		return provider.Account{}, errors.New("AI relay console or provider service is not available")
	}
	tokenID := strings.TrimSpace(req.TokenID)
	if tokenID == "" {
		return provider.Account{}, errors.New("missing token_id")
	}
	console, err := a.aiRelayConsole.GetAccount(ctx, req.ConsoleID)
	if err != nil {
		return provider.Account{}, err
	}
	tokenKey, token, err := a.aiRelayConsole.FetchTokenKey(ctx, req.ConsoleID, tokenID)
	if err != nil {
		return provider.Account{}, err
	}
	providerName := strings.TrimSpace(console.DisplayName)
	if token.Name != "" {
		providerName = providerName + " / " + token.Name
	}
	if providerName == "" {
		providerName = "New API Relay"
	}
	baseURL := strings.TrimRight(console.ConsoleBaseURL, "/") + "/v1"
	balanceEndpoint := strings.TrimRight(console.ConsoleBaseURL, "/") + "/api/usage/token/"
	item := provider.Account{
		ID:                     req.ProviderID,
		ProviderName:           providerName,
		BaseURL:                baseURL,
		BalanceSupported:       true,
		BalanceEndpoint:        balanceEndpoint,
		BalanceCacheTTLSeconds: 600,
		LowBalanceThreshold:    console.LowBalanceQuota,
		Enabled:                true,
	}
	item, err = a.aiProvider.UpsertAccount(ctx, item)
	if err != nil {
		return provider.Account{}, err
	}
	item, err = a.aiProvider.SetSecret(ctx, item.ID, tokenKey)
	if err != nil {
		return provider.Account{}, err
	}
	if strings.TrimSpace(item.ChatModel) == "" && len(item.AvailableModels) > 0 {
		item.ChatModel = item.AvailableModels[0]
		item.SummaryModel = item.ChatModel
		item, _ = a.aiProvider.UpsertAccount(ctx, item)
	}
	return item, nil
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
	return a.InsertAITextMessageWithSuggestions(ctx, conversationID, senderUsername, content, nil)
}

func (a *App) InsertAITextMessageWithSuggestions(ctx context.Context, conversationID int64, senderUsername string, content string, suggestions []string) (aiservice.MessageRef, error) {
	item, err := a.insertSystemTextMessage(ctx, conversationID, senderUsername, content, suggestions)
	if err != nil {
		return aiservice.MessageRef{}, err
	}
	a.broadcastMessageCreated(ctx, conversationID, item)
	return aiservice.MessageRef{
		ID:             item.ID,
		ConversationID: item.ConversationID,
		SenderUsername: item.SenderUsername,
		Content:        item.Content,
		Suggestions:    item.AISuggestions,
	}, nil
}

func (a *App) insertSystemTextMessage(ctx context.Context, conversationID int64, senderUsername string, content string, suggestions []string) (MessageItem, error) {
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
	normalizedSuggestions := normalizeAISuggestions(suggestions)
	if len(normalizedSuggestions) > 0 {
		suggestionBytes, marshalErr := json.Marshal(normalizedSuggestions)
		if marshalErr != nil {
			return MessageItem{}, marshalErr
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_ai_reply_suggestion (message_id, conversation_id, task_id, suggestions_json, created_at, updated_at)
			VALUES ($1, $2, '', $3::jsonb, NOW(), NOW())
			ON CONFLICT (message_id) DO UPDATE
			SET suggestions_json = EXCLUDED.suggestions_json, updated_at = NOW()`, item.ID, conversationID, string(suggestionBytes)); err != nil {
			return MessageItem{}, err
		}
		item.AISuggestions = normalizedSuggestions
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

func normalizeAISuggestions(suggestions []string) []string {
	result := make([]string, 0, 3)
	seen := map[string]struct{}{}
	for _, suggestion := range suggestions {
		text := strings.TrimSpace(suggestion)
		text = strings.Trim(text, "-* \t\r\n\"'`，。,.、")
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		runes := []rune(text)
		if len(runes) > 24 {
			text = string(runes[:24])
		}
		key := strings.ToLower(text)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, text)
		if len(result) >= 3 {
			break
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func (a *App) populateAIReplySuggestions(ctx context.Context, items []MessageItem) {
	if len(items) == 0 || a == nil || a.db == nil {
		return
	}
	messageIDs := make([]int64, 0, len(items))
	indexByMessageID := map[int64]int{}
	for index, item := range items {
		if item.ID <= 0 || !strings.EqualFold(strings.TrimSpace(item.SenderUsername), bot.Username) {
			continue
		}
		messageIDs = append(messageIDs, item.ID)
		indexByMessageID[item.ID] = index
	}
	if len(messageIDs) == 0 {
		return
	}
	placeholders := make([]string, 0, len(messageIDs))
	args := make([]any, 0, len(messageIDs))
	for index, messageID := range messageIDs {
		placeholders = append(placeholders, fmt.Sprintf("$%d", index+1))
		args = append(args, messageID)
	}
	rows, err := a.db.Query(ctx, `
		SELECT message_id, suggestions_json::text
		FROM im_ai_reply_suggestion
		WHERE message_id IN (`+strings.Join(placeholders, ",")+`)`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var messageID int64
		var raw string
		if err := rows.Scan(&messageID, &raw); err != nil {
			return
		}
		index, ok := indexByMessageID[messageID]
		if !ok {
			continue
		}
		var suggestions []string
		if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &suggestions); err != nil {
			continue
		}
		items[index].AISuggestions = normalizeAISuggestions(suggestions)
	}
}
