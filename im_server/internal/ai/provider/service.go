package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db           *pgxpool.Pool
	masterSecret string
	client       *http.Client
}

func New(db *pgxpool.Pool, masterSecret string, timeout time.Duration) *Service {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Service{
		db:           db,
		masterSecret: strings.TrimSpace(masterSecret),
		client:       &http.Client{Timeout: timeout},
	}
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_provider_account (
			id BIGSERIAL PRIMARY KEY,
			provider_name TEXT NOT NULL DEFAULT 'OpenAI-Compatible Relay',
			base_url TEXT NOT NULL DEFAULT '',
			secret_ciphertext_or_ref TEXT NOT NULL DEFAULT '',
			secret_fingerprint TEXT NOT NULL DEFAULT '',
			chat_model TEXT NOT NULL DEFAULT '',
			summary_model TEXT NOT NULL DEFAULT '',
			embedding_model TEXT NOT NULL DEFAULT '',
			balance_supported BOOLEAN NOT NULL DEFAULT FALSE,
			balance_endpoint TEXT NOT NULL DEFAULT '',
			balance_cache_ttl_seconds INTEGER NOT NULL DEFAULT 600,
			low_balance_threshold NUMERIC NOT NULL DEFAULT 0,
			enabled BOOLEAN NOT NULL DEFAULT FALSE,
			last_test_at TIMESTAMP,
			last_test_status TEXT NOT NULL DEFAULT '',
			last_used_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_provider_balance (
			provider_id BIGINT PRIMARY KEY REFERENCES im_ai_provider_account(id) ON DELETE CASCADE,
			balance_amount NUMERIC NOT NULL DEFAULT 0,
			balance_currency TEXT NOT NULL DEFAULT '',
			raw_unit TEXT NOT NULL DEFAULT '',
			low_balance_threshold NUMERIC NOT NULL DEFAULT 0,
			low_balance BOOLEAN NOT NULL DEFAULT FALSE,
			last_refresh_at TIMESTAMP,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
	}
	for index, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("provider schema statement #%d failed: %w", index+1, err)
		}
	}
	return nil
}

func (s *Service) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at, created_at, updated_at
		FROM im_ai_provider_account
		ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Account, 0)
	for rows.Next() {
		item, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type accountScanner interface {
	Scan(dest ...any) error
}

func scanAccount(row accountScanner) (Account, error) {
	var item Account
	err := row.Scan(
		&item.ID,
		&item.ProviderName,
		&item.BaseURL,
		&item.SecretFingerprint,
		&item.ChatModel,
		&item.SummaryModel,
		&item.EmbeddingModel,
		&item.BalanceSupported,
		&item.BalanceEndpoint,
		&item.BalanceCacheTTLSeconds,
		&item.LowBalanceThreshold,
		&item.Enabled,
		&item.LastTestAt,
		&item.LastTestStatus,
		&item.LastUsedAt,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	return item, err
}

func (s *Service) UpsertAccount(ctx context.Context, item Account) (Account, error) {
	baseURL, err := normalizeBaseURL(item.BaseURL)
	if err != nil {
		return Account{}, err
	}
	if item.ProviderName == "" {
		item.ProviderName = "OpenAI-Compatible Relay"
	}
	if item.ChatModel == "" {
		item.ChatModel = "gpt-5-mini"
	}
	if item.SummaryModel == "" {
		item.SummaryModel = item.ChatModel
	}
	if item.BalanceCacheTTLSeconds <= 0 {
		item.BalanceCacheTTLSeconds = 600
	}
	if item.ID > 0 {
		err = s.db.QueryRow(ctx, `
			UPDATE im_ai_provider_account
			SET provider_name = $2, base_url = $3, chat_model = $4, summary_model = $5, embedding_model = $6,
			    balance_supported = $7, balance_endpoint = $8, balance_cache_ttl_seconds = $9,
			    low_balance_threshold = $10, enabled = $11, updated_at = NOW()
			WHERE id = $1
			RETURNING id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model,
			       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
			       enabled, last_test_at, last_test_status, last_used_at, created_at, updated_at`,
			item.ID, item.ProviderName, baseURL, item.ChatModel, item.SummaryModel, item.EmbeddingModel,
			item.BalanceSupported, strings.TrimSpace(item.BalanceEndpoint), item.BalanceCacheTTLSeconds,
			item.LowBalanceThreshold, item.Enabled).Scan(
			&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
			&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
			&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt, &item.CreatedAt, &item.UpdatedAt)
		return item, err
	}
	err = s.db.QueryRow(ctx, `
		INSERT INTO im_ai_provider_account (provider_name, base_url, chat_model, summary_model, embedding_model,
			balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold, enabled, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
		RETURNING id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at, created_at, updated_at`,
		item.ProviderName, baseURL, item.ChatModel, item.SummaryModel, item.EmbeddingModel,
		item.BalanceSupported, strings.TrimSpace(item.BalanceEndpoint), item.BalanceCacheTTLSeconds,
		item.LowBalanceThreshold, item.Enabled).Scan(
		&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
		&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
		&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func normalizeBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		return "", errors.New("missing base_url")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid base_url")
	}
	if strings.ToLower(parsed.Scheme) != "https" {
		return "", errors.New("base_url must use https")
	}
	if isUnsafeHost(parsed.Hostname()) {
		return "", errors.New("base_url host is not allowed")
	}
	return value, nil
}

func isUnsafeHost(host string) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "" || normalized == "localhost" || strings.HasSuffix(normalized, ".local") {
		return true
	}
	if ip := net.ParseIP(normalized); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
	}
	return false
}

func (s *Service) SetSecret(ctx context.Context, providerID int64, secret string) (Account, error) {
	if providerID <= 0 {
		return Account{}, errors.New("invalid provider_id")
	}
	ciphertext, err := encryptSecret(s.masterSecret, secret)
	if err != nil {
		return Account{}, err
	}
	fingerprint := fingerprintSecret(secret)
	var item Account
	err = s.db.QueryRow(ctx, `
		UPDATE im_ai_provider_account
		SET secret_ciphertext_or_ref = $2, secret_fingerprint = $3, updated_at = NOW()
		WHERE id = $1
		RETURNING id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at, created_at, updated_at`,
		providerID, ciphertext, fingerprint).Scan(
		&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
		&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
		&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func (s *Service) LoadActiveAccount(ctx context.Context) (Account, string, error) {
	var item Account
	var ciphertext string
	err := s.db.QueryRow(ctx, `
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at, created_at, updated_at, secret_ciphertext_or_ref
		FROM im_ai_provider_account
		WHERE enabled = TRUE
		ORDER BY id ASC
		LIMIT 1`).Scan(
		&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
		&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
		&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt, &item.CreatedAt, &item.UpdatedAt, &ciphertext)
	if err != nil {
		return Account{}, "", err
	}
	secret, err := decryptSecret(s.masterSecret, ciphertext)
	if err != nil {
		return Account{}, "", err
	}
	return item, secret, nil
}

func (s *Service) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	account, secret, err := s.LoadActiveAccount(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ChatResponse{}, errors.New("AI provider is not configured")
		}
		return ChatResponse{}, err
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = account.ChatModel
	}
	if model == "" {
		return ChatResponse{}, errors.New("AI chat model is not configured")
	}
	maxTokens := req.MaxOutputTokens
	if maxTokens <= 0 {
		maxTokens = 800
	}
	temperature := req.Temperature
	if temperature <= 0 {
		temperature = 0.7
	}
	payload := map[string]any{
		"model":       model,
		"messages":    req.Messages,
		"temperature": temperature,
		"max_tokens":  maxTokens,
	}
	body, _ := json.Marshal(payload)
	endpoint := account.BaseURL + "/v1/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ChatResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+secret)
	resp, err := s.client.Do(httpReq)
	if err != nil {
		return ChatResponse{}, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return ChatResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ChatResponse{}, fmt.Errorf("AI provider status=%d", resp.StatusCode)
	}
	var parsed struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Usage   Usage  `json:"usage"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Text string `json:"text"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return ChatResponse{}, err
	}
	content := ""
	if len(parsed.Choices) > 0 {
		content = strings.TrimSpace(parsed.Choices[0].Message.Content)
		if content == "" {
			content = strings.TrimSpace(parsed.Choices[0].Text)
		}
	}
	if content == "" {
		return ChatResponse{}, errors.New("AI provider returned empty content")
	}
	_, _ = s.db.Exec(ctx, `UPDATE im_ai_provider_account SET last_used_at = NOW() WHERE id = $1`, account.ID)
	return ChatResponse{
		Content:           content,
		Model:             parsed.Model,
		ProviderID:        account.ID,
		UpstreamRequestID: parsed.ID,
		Usage:             parsed.Usage,
	}, nil
}

func (s *Service) Test(ctx context.Context, providerID int64) (TestResult, error) {
	started := time.Now()
	account, secret, err := s.loadAccountSecret(ctx, providerID)
	if err != nil {
		return TestResult{}, err
	}
	modelsResult := s.testModelsProbe(ctx, account, secret, started)
	result := modelsResult
	if !modelsResult.OK {
		chatResult := s.testChatProbe(ctx, account, secret, started)
		if chatResult.OK {
			chatResult.Message = "chat completions ok；/v1/models 不可用：" + modelsResult.Message
			result = chatResult
		} else {
			if chatResult.Message != "" && modelsResult.Message != "" {
				chatResult.Message = "models: " + modelsResult.Message + "；chat: " + chatResult.Message
			}
			result = chatResult
		}
	}
	statusText := "ok"
	if !result.OK {
		statusText = result.Message
	} else if result.Probe != "" {
		statusText = "ok (" + result.Probe + ")"
	}
	_, _ = s.db.Exec(ctx, `UPDATE im_ai_provider_account SET last_test_at = NOW(), last_test_status = $2, updated_at = NOW() WHERE id = $1`, providerID, statusText)
	return result, nil
}

func (s *Service) testModelsProbe(ctx context.Context, account Account, secret string, started time.Time) TestResult {
	endpoint := account.BaseURL + "/v1/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return TestResult{OK: false, Message: err.Error(), LatencyMS: time.Since(started).Milliseconds(), Probe: "models"}
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := s.client.Do(req)
	return finishProviderProbe(resp, err, started, "models")
}

func (s *Service) testChatProbe(ctx context.Context, account Account, secret string, started time.Time) TestResult {
	model := strings.TrimSpace(account.ChatModel)
	if model == "" {
		model = strings.TrimSpace(account.SummaryModel)
	}
	if model == "" {
		model = "gpt-5-mini"
	}
	payload := map[string]any{
		"model": model,
		"messages": []Message{
			{Role: "user", Content: "ping"},
		},
		"temperature": 0,
		"max_tokens":  8,
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, account.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return TestResult{OK: false, Message: err.Error(), LatencyMS: time.Since(started).Milliseconds(), Probe: "chat_completions"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := s.client.Do(req)
	return finishProviderProbe(resp, err, started, "chat_completions")
}

func finishProviderProbe(resp *http.Response, err error, started time.Time, probe string) TestResult {
	latency := time.Since(started).Milliseconds()
	status := 0
	message := "ok"
	ok := err == nil
	if resp != nil {
		status = resp.StatusCode
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		ok = status >= 200 && status < 300
		if !ok {
			message = formatProviderError(status, body)
		}
	}
	if err != nil {
		message = err.Error()
	} else if !ok && message == "" {
		message = fmt.Sprintf("provider status=%d", status)
	}
	return TestResult{OK: ok, Status: status, Message: message, LatencyMS: latency, Probe: probe}
}

func formatProviderError(status int, body []byte) string {
	rawText := truncateForStatus(strings.TrimSpace(string(body)), 220)
	var parsed struct {
		Error   any `json:"error"`
		Msg     any `json:"msg"`
		Message any `json:"message"`
	}
	if len(body) > 0 && json.Unmarshal(body, &parsed) == nil {
		for _, value := range []any{parsed.Message, parsed.Msg, parsed.Error} {
			if text := providerErrorText(value); text != "" {
				rawText = truncateForStatus(text, 220)
				break
			}
		}
	}
	if rawText == "" {
		return fmt.Sprintf("provider status=%d", status)
	}
	return fmt.Sprintf("provider status=%d: %s", status, rawText)
}

func providerErrorText(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case map[string]any:
		for _, key := range []string{"message", "msg", "error", "code"} {
			if text, ok := item[key].(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

func truncateForStatus(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func (s *Service) loadAccountSecret(ctx context.Context, providerID int64) (Account, string, error) {
	if providerID <= 0 {
		return Account{}, "", errors.New("invalid provider_id")
	}
	var item Account
	var ciphertext string
	err := s.db.QueryRow(ctx, `
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at, created_at, updated_at, secret_ciphertext_or_ref
		FROM im_ai_provider_account
		WHERE id = $1`, providerID).Scan(
		&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
		&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
		&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt, &item.CreatedAt, &item.UpdatedAt, &ciphertext)
	if err != nil {
		return Account{}, "", err
	}
	secret, err := decryptSecret(s.masterSecret, ciphertext)
	if err != nil {
		return Account{}, "", err
	}
	return item, secret, nil
}

func (s *Service) RefreshBalance(ctx context.Context, providerID int64) (Balance, error) {
	account, secret, err := s.loadAccountSecret(ctx, providerID)
	if err != nil {
		return Balance{}, err
	}
	if !account.BalanceSupported || strings.TrimSpace(account.BalanceEndpoint) == "" {
		balance := Balance{ProviderID: providerID, Supported: false, LastError: "provider does not support balance query"}
		_ = s.upsertBalanceError(ctx, account, balance.LastError)
		return balance, nil
	}
	endpoint, err := buildProviderURL(account.BaseURL, account.BalanceEndpoint)
	if err != nil {
		return Balance{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Balance{}, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := s.client.Do(req)
	if err != nil {
		_ = s.upsertBalanceError(ctx, account, err.Error())
		return Balance{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		_ = s.upsertBalanceError(ctx, account, err.Error())
		return Balance{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := fmt.Sprintf("balance status=%d", resp.StatusCode)
		_ = s.upsertBalanceError(ctx, account, message)
		return Balance{}, errors.New(message)
	}
	amount, currency, unit := parseBalance(body)
	low := account.LowBalanceThreshold > 0 && amount <= account.LowBalanceThreshold
	var balance Balance
	err = s.db.QueryRow(ctx, `
		INSERT INTO im_ai_provider_balance (provider_id, balance_amount, balance_currency, raw_unit, low_balance_threshold, low_balance, last_refresh_at, last_error, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW(), '', NOW())
		ON CONFLICT (provider_id) DO UPDATE
		SET balance_amount = EXCLUDED.balance_amount,
		    balance_currency = EXCLUDED.balance_currency,
		    raw_unit = EXCLUDED.raw_unit,
		    low_balance_threshold = EXCLUDED.low_balance_threshold,
		    low_balance = EXCLUDED.low_balance,
		    last_refresh_at = NOW(),
		    last_error = '',
		    updated_at = NOW()
		RETURNING provider_id, balance_amount::float8, balance_currency, raw_unit, low_balance_threshold::float8, low_balance, last_refresh_at, last_error, updated_at`,
		account.ID, amount, currency, unit, account.LowBalanceThreshold, low).Scan(
		&balance.ProviderID, &balance.BalanceAmount, &balance.BalanceCurrency, &balance.RawUnit,
		&balance.LowBalanceThreshold, &balance.LowBalance, &balance.LastRefreshAt, &balance.LastError, &balance.UpdatedAt)
	balance.Supported = true
	return balance, err
}

func buildProviderURL(baseURL string, endpoint string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", errors.New("empty balance endpoint")
	}
	if strings.HasPrefix(endpoint, "https://") {
		normalized, err := normalizeBaseURL(endpoint)
		if err != nil {
			return "", err
		}
		return normalized, nil
	}
	if !strings.HasPrefix(endpoint, "/") {
		endpoint = "/" + endpoint
	}
	return strings.TrimRight(baseURL, "/") + endpoint, nil
}

func parseBalance(body []byte) (float64, string, string) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return 0, "", "unknown"
	}
	currency := stringField(raw, "currency", "unit")
	for _, key := range []string{"balance", "remaining", "amount", "credit", "credits", "quota"} {
		if value, ok := numberField(raw, key); ok {
			return value, currency, key
		}
	}
	if data, ok := raw["data"].(map[string]any); ok {
		for _, key := range []string{"balance", "remaining", "amount", "credit", "credits", "quota"} {
			if value, ok := numberField(data, key); ok {
				if currency == "" {
					currency = stringField(data, "currency", "unit")
				}
				return value, currency, "data." + key
			}
		}
	}
	return 0, currency, "unknown"
}

func numberField(raw map[string]any, key string) (float64, bool) {
	switch value := raw[key].(type) {
	case float64:
		return value, true
	case int:
		return float64(value), true
	case json.Number:
		parsed, err := value.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func stringField(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := raw[key].(string); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (s *Service) upsertBalanceError(ctx context.Context, account Account, message string) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_provider_balance (provider_id, low_balance_threshold, last_error, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (provider_id) DO UPDATE
		SET low_balance_threshold = EXCLUDED.low_balance_threshold,
		    last_error = EXCLUDED.last_error,
		    updated_at = NOW()`, account.ID, account.LowBalanceThreshold, strings.TrimSpace(message))
	return err
}

func (s *Service) GetBalance(ctx context.Context, providerID int64) (Balance, error) {
	var item Balance
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(b.provider_id, a.id),
		       COALESCE(b.balance_amount, 0)::float8,
		       COALESCE(b.balance_currency, ''),
		       COALESCE(b.raw_unit, ''),
		       COALESCE(b.low_balance_threshold, a.low_balance_threshold)::float8,
		       COALESCE(b.low_balance, FALSE),
		       b.last_refresh_at,
		       COALESCE(b.last_error, ''),
		       b.updated_at,
		       a.balance_supported
		FROM im_ai_provider_account a
		LEFT JOIN im_ai_provider_balance b ON b.provider_id = a.id
		WHERE a.id = $1`, providerID).Scan(
		&item.ProviderID, &item.BalanceAmount, &item.BalanceCurrency, &item.RawUnit,
		&item.LowBalanceThreshold, &item.LowBalance, &item.LastRefreshAt, &item.LastError, &item.UpdatedAt,
		&item.Supported)
	if err != nil {
		return Balance{}, err
	}
	if item.ProviderID == 0 {
		item.ProviderID = providerID
	}
	return item, nil
}
