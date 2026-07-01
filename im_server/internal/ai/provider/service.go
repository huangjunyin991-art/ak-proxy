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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db           *pgxpool.Pool
	masterSecret string
	client       *http.Client
	lbMu         sync.RWMutex
	lbConfig     LoadBalanceConfig
}

type LoadBalanceConfig struct {
	Enabled         bool
	MaxAttempts     int
	CooldownSeconds int
}

func New(db *pgxpool.Pool, masterSecret string, timeout time.Duration) *Service {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Service{
		db:           db,
		masterSecret: strings.TrimSpace(masterSecret),
		client:       &http.Client{Timeout: timeout},
		lbConfig:     defaultLoadBalanceConfig(),
	}
}

func defaultLoadBalanceConfig() LoadBalanceConfig {
	return LoadBalanceConfig{
		Enabled:         true,
		MaxAttempts:     3,
		CooldownSeconds: 300,
	}
}

func normalizeLoadBalanceConfig(cfg LoadBalanceConfig) LoadBalanceConfig {
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 3
	}
	if cfg.MaxAttempts > 10 {
		cfg.MaxAttempts = 10
	}
	if cfg.CooldownSeconds <= 0 {
		cfg.CooldownSeconds = 300
	}
	if cfg.CooldownSeconds > 3600 {
		cfg.CooldownSeconds = 3600
	}
	return cfg
}

func (s *Service) SetLoadBalanceConfig(cfg LoadBalanceConfig) LoadBalanceConfig {
	cfg = normalizeLoadBalanceConfig(cfg)
	if s == nil {
		return cfg
	}
	s.lbMu.Lock()
	s.lbConfig = cfg
	s.lbMu.Unlock()
	return cfg
}

func (s *Service) LoadBalanceConfig() LoadBalanceConfig {
	cfg := defaultLoadBalanceConfig()
	if s == nil {
		return cfg
	}
	s.lbMu.RLock()
	cfg = s.lbConfig
	s.lbMu.RUnlock()
	return normalizeLoadBalanceConfig(cfg)
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
			available_models JSONB NOT NULL DEFAULT '[]'::jsonb,
			balance_supported BOOLEAN NOT NULL DEFAULT FALSE,
			balance_endpoint TEXT NOT NULL DEFAULT '',
			balance_cache_ttl_seconds INTEGER NOT NULL DEFAULT 600,
			low_balance_threshold NUMERIC NOT NULL DEFAULT 0,
			enabled BOOLEAN NOT NULL DEFAULT FALSE,
			last_test_at TIMESTAMP,
			last_test_status TEXT NOT NULL DEFAULT '',
			last_used_at TIMESTAMP,
			runtime_disabled_until TIMESTAMP,
			runtime_failure_count INTEGER NOT NULL DEFAULT 0,
			runtime_last_error TEXT NOT NULL DEFAULT '',
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
		`ALTER TABLE im_ai_provider_account ADD COLUMN IF NOT EXISTS available_models JSONB NOT NULL DEFAULT '[]'::jsonb`,
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
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at,
		       runtime_disabled_until, runtime_failure_count, runtime_last_error,
		       created_at, updated_at
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

func (s *Service) GetAccount(ctx context.Context, providerID int64) (Account, error) {
	if providerID <= 0 {
		return Account{}, errors.New("invalid provider_id")
	}
	row := s.db.QueryRow(ctx, `
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at,
		       runtime_disabled_until, runtime_failure_count, runtime_last_error,
		       created_at, updated_at
		FROM im_ai_provider_account
		WHERE id = $1`, providerID)
	return scanAccount(row)
}

type accountScanner interface {
	Scan(dest ...any) error
}

func scanAccount(row accountScanner) (Account, error) {
	var item Account
	var availableModelsRaw []byte
	err := row.Scan(
		&item.ID,
		&item.ProviderName,
		&item.BaseURL,
		&item.SecretFingerprint,
		&item.ChatModel,
		&item.SummaryModel,
		&item.EmbeddingModel,
		&availableModelsRaw,
		&item.BalanceSupported,
		&item.BalanceEndpoint,
		&item.BalanceCacheTTLSeconds,
		&item.LowBalanceThreshold,
		&item.Enabled,
		&item.LastTestAt,
		&item.LastTestStatus,
		&item.LastUsedAt,
		&item.RuntimeDisabledUntil,
		&item.RuntimeFailureCount,
		&item.RuntimeLastError,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	if len(availableModelsRaw) > 0 {
		_ = json.Unmarshal(availableModelsRaw, &item.AvailableModels)
	}
	if item.AvailableModels == nil {
		item.AvailableModels = []string{}
	}
	sanitizeAccountModels(&item)
	return item, err
}

func sanitizeAccountModels(item *Account) {
	if item == nil || len(item.AvailableModels) == 0 {
		return
	}
	defaultChatModel := chooseDefaultChatModel(item.AvailableModels, "")
	if strings.TrimSpace(item.ChatModel) != "" && (isLikelyNonChatModel(item.ChatModel) || !modelAvailable(item.AvailableModels, item.ChatModel)) {
		item.ChatModel = defaultChatModel
	}
	if strings.TrimSpace(item.SummaryModel) != "" && (isLikelyNonChatModel(item.SummaryModel) || !modelAvailable(item.AvailableModels, item.SummaryModel)) {
		item.SummaryModel = defaultChatModel
	}
	item.EmbeddingModel = ""
}

func (s *Service) UpsertAccount(ctx context.Context, item Account) (Account, error) {
	baseURL, err := normalizeBaseURL(item.BaseURL)
	if err != nil {
		return Account{}, err
	}
	if item.ProviderName == "" {
		item.ProviderName = "OpenAI-Compatible Relay"
	}
	if item.SummaryModel == "" {
		item.SummaryModel = item.ChatModel
	}
	item.EmbeddingModel = ""
	if item.BalanceCacheTTLSeconds <= 0 {
		item.BalanceCacheTTLSeconds = 600
	}
	if item.ID > 0 {
		row := s.db.QueryRow(ctx, `
			UPDATE im_ai_provider_account
			SET provider_name = $2, base_url = $3, chat_model = $4, summary_model = $5, embedding_model = $6,
			    balance_supported = $7, balance_endpoint = $8, balance_cache_ttl_seconds = $9,
			    low_balance_threshold = $10, enabled = $11, updated_at = NOW()
			WHERE id = $1
			RETURNING id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
			       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
			       enabled, last_test_at, last_test_status, last_used_at,
			       runtime_disabled_until, runtime_failure_count, runtime_last_error,
			       created_at, updated_at`,
			item.ID, item.ProviderName, baseURL, item.ChatModel, item.SummaryModel, item.EmbeddingModel,
			item.BalanceSupported, strings.TrimSpace(item.BalanceEndpoint), item.BalanceCacheTTLSeconds,
			item.LowBalanceThreshold, item.Enabled)
		item, err = scanAccount(row)
		return item, err
	}
	row := s.db.QueryRow(ctx, `
		INSERT INTO im_ai_provider_account (provider_name, base_url, chat_model, summary_model, embedding_model,
			balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold, enabled, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
		RETURNING id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at,
		       runtime_disabled_until, runtime_failure_count, runtime_last_error,
		       created_at, updated_at`,
		item.ProviderName, baseURL, item.ChatModel, item.SummaryModel, item.EmbeddingModel,
		item.BalanceSupported, strings.TrimSpace(item.BalanceEndpoint), item.BalanceCacheTTLSeconds,
		item.LowBalanceThreshold, item.Enabled)
	item, err = scanAccount(row)
	return item, err
}

func (s *Service) DeleteAccount(ctx context.Context, providerID int64) error {
	if providerID <= 0 {
		return errors.New("invalid provider_id")
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM im_ai_provider_account WHERE id = $1`, providerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
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
		message := err.Error()
		if strings.Contains(message, "IM_AI_SECRET_KEY") {
			message = "服务器缺少 IM_AI_SECRET_KEY，无法加密保存 Provider API Key"
		}
		return Account{}, errors.New(message)
	}
	fingerprint := fingerprintSecret(secret)
	row := s.db.QueryRow(ctx, `
		UPDATE im_ai_provider_account
		SET secret_ciphertext_or_ref = $2, secret_fingerprint = $3, updated_at = NOW()
		WHERE id = $1
		RETURNING id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at,
		       runtime_disabled_until, runtime_failure_count, runtime_last_error,
		       created_at, updated_at`,
		providerID, ciphertext, fingerprint)
	item, err := scanAccount(row)
	if err != nil {
		return Account{}, err
	}
	if models, refreshErr := s.RefreshModels(ctx, providerID); refreshErr == nil && len(models) > 0 {
		if refreshed, loadErr := s.GetAccount(ctx, providerID); loadErr == nil {
			item = refreshed
		}
	} else if refreshErr != nil {
		_, _ = s.db.Exec(ctx, `UPDATE im_ai_provider_account SET last_test_status = $2, updated_at = NOW() WHERE id = $1`, providerID, "models: "+truncateForStatus(refreshErr.Error(), 180))
		if refreshed, loadErr := s.GetAccount(ctx, providerID); loadErr == nil {
			item = refreshed
		}
	}
	return item, nil
}

func (s *Service) LoadActiveAccount(ctx context.Context) (Account, string, error) {
	cfg := s.LoadBalanceConfig()
	limit := 1
	if cfg.Enabled {
		limit = cfg.MaxAttempts
	}
	candidates, err := s.loadProviderCandidates(ctx, limit, cfg.Enabled)
	if err != nil {
		return Account{}, "", err
	}
	if len(candidates) == 0 {
		return Account{}, "", pgx.ErrNoRows
	}
	return candidates[0].account, candidates[0].secret, nil
}

func (s *Service) ConfiguredAccountIDs(ctx context.Context) (map[int64]struct{}, error) {
	result := map[int64]struct{}{}
	if s == nil || s.db == nil {
		return result, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT id
		FROM im_ai_provider_account
		WHERE enabled = TRUE
		  AND secret_ciphertext_or_ref <> ''`)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return result, err
		}
		result[id] = struct{}{}
	}
	return result, rows.Err()
}

func (s *Service) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	return s.chatWithProviderPool(ctx, req, "chat")
}

func (s *Service) Summary(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	return s.chatWithProviderPool(ctx, req, "summary")
}

type providerCandidate struct {
	account Account
	secret  string
}

func (s *Service) chatWithProviderPool(ctx context.Context, req ChatRequest, purpose string) (ChatResponse, error) {
	cfg := s.LoadBalanceConfig()
	limit := 1
	onlyReady := false
	if cfg.Enabled {
		limit = cfg.MaxAttempts
		onlyReady = true
	}
	candidates, err := s.loadProviderCandidates(ctx, limit, onlyReady)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ChatResponse{}, s.providerPoolUnavailableError(ctx, onlyReady)
		}
		return ChatResponse{}, err
	}
	if len(candidates) == 0 {
		return ChatResponse{}, s.providerPoolUnavailableError(ctx, onlyReady)
	}
	attemptErrors := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		response, err := s.chatWithCandidate(ctx, candidate, req, purpose)
		if err == nil {
			_ = s.markProviderSuccess(ctx, candidate.account.ID)
			return response, nil
		}
		attemptErrors = append(attemptErrors, fmt.Sprintf("#%d %s: %s", candidate.account.ID, candidate.account.ProviderName, truncateForStatus(err.Error(), 160)))
		if shouldCooldownProvider(ctx, err) {
			_ = s.markProviderFailure(ctx, candidate.account.ID, err, cfg)
		} else {
			_ = s.markProviderRuntimeError(ctx, candidate.account.ID, err)
		}
		if !cfg.Enabled || !shouldTryNextProvider(ctx, err) {
			break
		}
	}
	if len(attemptErrors) == 0 {
		return ChatResponse{}, errors.New("AI provider is not configured")
	}
	return ChatResponse{}, fmt.Errorf("AI provider attempts failed: %s", strings.Join(attemptErrors, "; "))
}

func (s *Service) chatWithCandidate(ctx context.Context, candidate providerCandidate, req ChatRequest, purpose string) (ChatResponse, error) {
	if purpose == "summary" {
		model := resolveSummaryModel(candidate.account, req.Model)
		if model == "" {
			return ChatResponse{}, errors.New("AI summary model is not configured")
		}
		return s.chatWithResolvedModel(ctx, candidate.account, candidate.secret, req, model, "summary")
	}
	return s.chatWithAccount(ctx, candidate.account, candidate.secret, req)
}

func (s *Service) loadProviderCandidates(ctx context.Context, limit int, onlyReady bool) ([]providerCandidate, error) {
	if s == nil || s.db == nil {
		return nil, pgx.ErrNoRows
	}
	if limit <= 0 {
		limit = 1
	}
	readyClause := ""
	if onlyReady {
		readyClause = "AND (runtime_disabled_until IS NULL OR runtime_disabled_until <= NOW())"
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at,
		       runtime_disabled_until, runtime_failure_count, runtime_last_error,
		       created_at, updated_at, secret_ciphertext_or_ref
		FROM im_ai_provider_account
		WHERE enabled = TRUE
		  AND secret_ciphertext_or_ref <> ''
		  `+readyClause+`
		ORDER BY runtime_failure_count ASC, COALESCE(last_used_at, TIMESTAMP '1970-01-01') ASC, id ASC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]providerCandidate, 0, limit)
	var skipped []string
	for rows.Next() {
		var item Account
		var availableModelsRaw []byte
		var ciphertext string
		if err := rows.Scan(
			&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
			&availableModelsRaw,
			&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
			&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt,
			&item.RuntimeDisabledUntil, &item.RuntimeFailureCount, &item.RuntimeLastError,
			&item.CreatedAt, &item.UpdatedAt, &ciphertext,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(availableModelsRaw, &item.AvailableModels)
		if item.AvailableModels == nil {
			item.AvailableModels = []string{}
		}
		sanitizeAccountModels(&item)
		secret, err := decryptSecret(s.masterSecret, ciphertext)
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("#%d: %s", item.ID, truncateForStatus(err.Error(), 120)))
			continue
		}
		candidates = append(candidates, providerCandidate{account: item, secret: secret})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		if len(skipped) > 0 {
			return nil, errors.New("AI provider secret decrypt failed: " + strings.Join(skipped, "; "))
		}
		return nil, pgx.ErrNoRows
	}
	return candidates, nil
}

func (s *Service) providerPoolUnavailableError(ctx context.Context, onlyReady bool) error {
	if !onlyReady {
		return errors.New("AI provider is not configured")
	}
	configured, err := s.hasConfiguredProvider(ctx)
	if err != nil {
		return err
	}
	if !configured {
		return errors.New("AI provider is not configured")
	}
	return errors.New("当前 AI 中转站繁忙，请稍后再试")
}

func (s *Service) hasConfiguredProvider(ctx context.Context) (bool, error) {
	if s == nil || s.db == nil {
		return false, nil
	}
	var exists bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM im_ai_provider_account
			WHERE enabled = TRUE
			  AND secret_ciphertext_or_ref <> ''
		)`).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

func (s *Service) markProviderSuccess(ctx context.Context, providerID int64) error {
	if s == nil || s.db == nil || providerID <= 0 {
		return nil
	}
	_, err := s.db.Exec(ctx, `
		UPDATE im_ai_provider_account
		SET last_used_at = NOW(),
		    runtime_disabled_until = NULL,
		    runtime_failure_count = 0,
		    runtime_last_error = '',
		    updated_at = NOW()
		WHERE id = $1`, providerID)
	return err
}

func (s *Service) markProviderFailure(ctx context.Context, providerID int64, cause error, cfg LoadBalanceConfig) error {
	if s == nil || s.db == nil || providerID <= 0 || cause == nil {
		return nil
	}
	cfg = normalizeLoadBalanceConfig(cfg)
	cooldown := cfg.CooldownSeconds
	message := truncateForStatus(cause.Error(), 300)
	_, err := s.db.Exec(ctx, `
		UPDATE im_ai_provider_account
		SET runtime_disabled_until = NOW() + ($2::int * INTERVAL '1 second'),
		    runtime_failure_count = runtime_failure_count + 1,
		    runtime_last_error = $3,
		    last_test_status = $4,
		    updated_at = NOW()
		WHERE id = $1`, providerID, cooldown, message, "runtime failure: "+message)
	return err
}

func (s *Service) markProviderRuntimeError(ctx context.Context, providerID int64, cause error) error {
	if s == nil || s.db == nil || providerID <= 0 || cause == nil {
		return nil
	}
	message := truncateForStatus(cause.Error(), 300)
	_, err := s.db.Exec(ctx, `
		UPDATE im_ai_provider_account
		SET runtime_last_error = $2,
		    last_test_status = $3,
		    updated_at = NOW()
		WHERE id = $1`, providerID, message, "runtime error: "+message)
	return err
}

type providerFailureClass int

const (
	providerFailureNone providerFailureClass = iota
	providerFailureRetryable
	providerFailurePermanent
	providerFailureContextDone
)

func shouldCooldownProvider(ctx context.Context, err error) bool {
	return classifyProviderFailure(ctx, err) == providerFailureRetryable
}

func shouldTryNextProvider(ctx context.Context, err error) bool {
	return classifyProviderFailure(ctx, err) == providerFailureRetryable
}

func classifyProviderFailure(ctx context.Context, err error) providerFailureClass {
	if err == nil {
		return providerFailureNone
	}
	if ctx != nil && ctx.Err() != nil {
		return providerFailureContextDone
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return providerFailureContextDone
	}
	if status, ok := providerErrorHTTPStatus(err); ok {
		if isRetryableProviderStatus(status) {
			return providerFailureRetryable
		}
		if status >= 400 && status < 500 {
			return providerFailurePermanent
		}
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return providerFailureRetryable
	}
	message := strings.ToLower(err.Error())
	if containsAny(message, []string{
		"timeout", "deadline exceeded", "connection refused", "connection reset",
		"temporary", "temporarily", "no such host", "server busy", "too many requests",
		"rate limit", "quota", "no available channel", "bad gateway", "service unavailable",
	}) {
		return providerFailureRetryable
	}
	if containsAny(message, []string{
		"unauthorized", "forbidden", "invalid api key", "incorrect api key",
		"invalid key", "invalid model", "model not found", "does not exist",
		"not supported", "not configured", "missing base_url", "invalid base_url",
	}) {
		return providerFailurePermanent
	}
	return providerFailureRetryable
}

func providerErrorHTTPStatus(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	message := err.Error()
	index := strings.Index(message, "provider status=")
	if index < 0 {
		return 0, false
	}
	start := index + len("provider status=")
	end := start
	for end < len(message) && message[end] >= '0' && message[end] <= '9' {
		end++
	}
	if end == start {
		return 0, false
	}
	status, convErr := strconv.Atoi(message[start:end])
	if convErr != nil {
		return 0, false
	}
	return status, true
}

func isRetryableProviderStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError,
		http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return status >= 500
	}
}

func containsAny(value string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func (s *Service) chatWithAccount(ctx context.Context, account Account, secret string, req ChatRequest) (ChatResponse, error) {
	model := resolveChatModel(account, req.Model)
	if model == "" {
		return ChatResponse{}, errors.New("AI chat model is not configured")
	}
	return s.chatWithResolvedModel(ctx, account, secret, req, model, "chat")
}

func (s *Service) chatWithResolvedModel(ctx context.Context, account Account, secret string, req ChatRequest, model string, purpose string) (ChatResponse, error) {
	model = strings.TrimSpace(model)
	if model == "" {
		return ChatResponse{}, errors.New("AI model is not configured")
	}
	temperature := req.Temperature
	if temperature <= 0 {
		temperature = 0.7
	}
	messages := appendModelIdentityGuard(req.Messages, model)
	payload := map[string]any{
		"model":       model,
		"messages":    messages,
		"temperature": temperature,
	}
	if req.MaxOutputTokens > 0 {
		payload["max_tokens"] = req.MaxOutputTokens
	}
	body, _ := json.Marshal(payload)
	endpoint := providerAPIURL(account.BaseURL, "/chat/completions")
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
		return ChatResponse{}, fmt.Errorf("AI provider %s failed (model=%s): %s", purpose, model, formatProviderError(resp.StatusCode, respBody))
	}
	var parsed struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Usage   Usage  `json:"usage"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Text         string `json:"text"`
			FinishReason string `json:"finish_reason"`
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
	finishReason := ""
	if len(parsed.Choices) > 0 {
		finishReason = strings.TrimSpace(parsed.Choices[0].FinishReason)
	}
	responseModel := strings.TrimSpace(parsed.Model)
	if responseModel == "" {
		responseModel = model
	}
	return ChatResponse{
		Content:           content,
		Model:             responseModel,
		ProviderID:        account.ID,
		UpstreamRequestID: parsed.ID,
		FinishReason:      finishReason,
		Usage:             parsed.Usage,
	}, nil
}

func (s *Service) Test(ctx context.Context, providerID int64, prompt string, model string) (TestResult, error) {
	started := time.Now()
	account, secret, err := s.loadAccountSecret(ctx, providerID)
	if err != nil {
		return TestResult{}, err
	}
	modelsResult := s.testModelsProbe(ctx, account, secret, started)
	if modelsResult.OK {
		if models, refreshErr := s.RefreshModels(ctx, providerID); refreshErr == nil && len(models) > 0 {
			if refreshed, refreshedSecret, loadErr := s.loadAccountSecret(ctx, providerID); loadErr == nil {
				account = refreshed
				secret = refreshedSecret
			}
			modelsResult.Message = fmt.Sprintf("models ok: %d", len(models))
		} else if refreshErr != nil {
			modelsResult.OK = false
			modelsResult.Message = refreshErr.Error()
		}
	}
	result := s.testChatProbe(ctx, account, secret, started, prompt, model)
	switchMessage := ""
	if !result.OK && shouldTryAlternateChatModel(result.Message) {
		fallback, tried := s.tryAlternateChatModels(ctx, account, secret, started, prompt, result.Model)
		if fallback.OK {
			result = fallback
			modelName := strings.TrimSpace(fallback.Model)
			if modelName != "" {
				summaryNeedsUpdate := strings.TrimSpace(account.SummaryModel) == "" ||
					isLikelyNonChatModel(account.SummaryModel) ||
					strings.EqualFold(strings.TrimSpace(account.SummaryModel), strings.TrimSpace(account.ChatModel)) ||
					strings.EqualFold(strings.TrimSpace(account.SummaryModel), strings.TrimSpace(model))
				_, _ = s.db.Exec(ctx, `
					UPDATE im_ai_provider_account
					SET chat_model = $2,
					    summary_model = CASE WHEN $3 THEN $2 ELSE summary_model END,
					    updated_at = NOW()
					WHERE id = $1`, providerID, modelName, summaryNeedsUpdate)
				switchMessage = fmt.Sprintf("当前模型不可用，已自动切换到 %s", modelName)
			}
		} else if tried > 0 {
			result.Message = result.Message + fmt.Sprintf("；已尝试 %d 个候选模型，仍未找到可用聊天通道", tried)
		}
	}
	if result.OK {
		if modelsResult.OK {
			result.Message = "chat completions ok；" + modelsResult.Message
		} else if modelsResult.Message != "" {
			result.Message = "chat completions ok；/v1/models 不可用：" + modelsResult.Message
		}
		if switchMessage != "" {
			result.Message = switchMessage + "；" + result.Message
		}
	} else if modelsResult.Message != "" {
		result.Message = "models: " + modelsResult.Message + "；chat: " + result.Message
	}
	statusText := "ok"
	if !result.OK {
		statusText = result.Message
	} else if result.Probe != "" {
		statusText = "ok (" + result.Probe + "; " + strings.TrimSpace(result.Model) + ")"
	}
	_, _ = s.db.Exec(ctx, `UPDATE im_ai_provider_account SET last_test_at = NOW(), last_test_status = $2, updated_at = NOW() WHERE id = $1`, providerID, statusText)
	return result, nil
}

func (s *Service) RefreshModels(ctx context.Context, providerID int64) ([]string, error) {
	account, secret, err := s.loadAccountSecret(ctx, providerID)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, providerAPIURL(account.BaseURL, "/models"), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("models status=%d: %s", resp.StatusCode, truncateForStatus(string(body), 180))
	}
	models := parseModels(body)
	if len(models) == 0 {
		return nil, errors.New("provider returned empty model list")
	}
	raw, _ := json.Marshal(models)
	defaultChatModel := chooseDefaultChatModel(models, account.ChatModel)
	replaceChatModel := strings.TrimSpace(account.ChatModel) == "" || isLikelyNonChatModel(account.ChatModel) || !modelAvailable(models, account.ChatModel)
	replaceSummaryModel := strings.TrimSpace(account.SummaryModel) == "" || isLikelyNonChatModel(account.SummaryModel) || !modelAvailable(models, account.SummaryModel)
	_, err = s.db.Exec(ctx, `
		UPDATE im_ai_provider_account
		SET available_models = $2::jsonb,
		    chat_model = CASE WHEN $4 THEN $3 ELSE chat_model END,
		    summary_model = CASE WHEN $5 THEN $3 ELSE summary_model END,
		    updated_at = NOW(),
		    last_test_status = 'models refreshed'
		WHERE id = $1`, providerID, string(raw), defaultChatModel, replaceChatModel, replaceSummaryModel)
	if err != nil {
		return nil, err
	}
	return models, nil
}

func (s *Service) testModelsProbe(ctx context.Context, account Account, secret string, started time.Time) TestResult {
	endpoint := providerAPIURL(account.BaseURL, "/models")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return TestResult{OK: false, Message: err.Error(), LatencyMS: time.Since(started).Milliseconds(), Probe: "models"}
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := s.client.Do(req)
	return finishProviderProbe(resp, err, started, "models")
}

func (s *Service) testChatProbe(ctx context.Context, account Account, secret string, started time.Time, prompt string, model string) TestResult {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		prompt = "请只回复两个字：可用"
	}
	probeModel := resolveChatModel(account, model)
	response, err := s.chatWithAccount(ctx, account, secret, ChatRequest{
		Model: probeModel,
		Messages: []Message{
			{Role: "system", Content: "You are testing an OpenAI-compatible chat completion endpoint. Reply briefly."},
			{Role: "user", Content: prompt},
		},
		MaxOutputTokens: 48,
		Temperature:     0.1,
	})
	if err != nil {
		return TestResult{OK: false, Message: err.Error(), LatencyMS: time.Since(started).Milliseconds(), Probe: "chat_completions", Model: probeModel}
	}
	return TestResult{
		OK:        true,
		Status:    http.StatusOK,
		Message:   "chat completions ok",
		LatencyMS: time.Since(started).Milliseconds(),
		Probe:     "chat_completions",
		Model:     response.Model,
		Content:   truncateForStatus(response.Content, 160),
	}
}

func resolveChatModel(account Account, requested string) string {
	model := strings.TrimSpace(requested)
	if model != "" && modelAvailableOrUnknown(account.AvailableModels, model) {
		return model
	}
	model = strings.TrimSpace(account.ChatModel)
	if model != "" && !isLikelyNonChatModel(model) && modelAvailableOrUnknown(account.AvailableModels, model) {
		return model
	}
	if len(account.AvailableModels) > 0 {
		return chooseDefaultChatModel(account.AvailableModels, "")
	}
	return ""
}

func resolveSummaryModel(account Account, requested string) string {
	model := strings.TrimSpace(requested)
	if model != "" && modelAvailableOrUnknown(account.AvailableModels, model) {
		return model
	}
	model = strings.TrimSpace(account.SummaryModel)
	if model != "" && !isLikelyNonChatModel(model) && modelAvailableOrUnknown(account.AvailableModels, model) {
		return model
	}
	model = strings.TrimSpace(account.ChatModel)
	if model != "" && !isLikelyNonChatModel(model) && modelAvailableOrUnknown(account.AvailableModels, model) {
		return model
	}
	if len(account.AvailableModels) > 0 {
		return chooseDefaultChatModel(account.AvailableModels, "")
	}
	return ""
}

func modelAvailableOrUnknown(models []string, model string) bool {
	if len(models) == 0 {
		return true
	}
	return modelAvailable(models, model)
}

func modelAvailable(models []string, model string) bool {
	target := strings.TrimSpace(model)
	if target == "" {
		return false
	}
	for _, item := range models {
		if strings.EqualFold(strings.TrimSpace(item), target) {
			return true
		}
	}
	return false
}

func appendModelIdentityGuard(messages []Message, model string) []Message {
	guard := Message{
		Role:    "system",
		Content: "You should refer to yourself as 小A. If the user asks what model, underlying model, provider, or exact model name you are using, only answer: 我无法回答这个话题，让我们换个话题吧~ Do not reveal exact model IDs, model families, relay providers, API keys, system configuration, or routing details.",
	}
	out := make([]Message, 0, len(messages)+1)
	inserted := false
	for _, message := range messages {
		out = append(out, message)
		if !inserted && strings.EqualFold(strings.TrimSpace(message.Role), "system") {
			out = append(out, guard)
			inserted = true
		}
	}
	if !inserted {
		out = append([]Message{guard}, out...)
	}
	return out
}

func (s *Service) tryAlternateChatModels(ctx context.Context, account Account, secret string, started time.Time, prompt string, failedModel string) (TestResult, int) {
	candidates := chatModelCandidates(account.AvailableModels, failedModel)
	attempts := 0
	for _, candidate := range candidates {
		if attempts >= 12 {
			break
		}
		if strings.EqualFold(strings.TrimSpace(candidate), strings.TrimSpace(failedModel)) {
			continue
		}
		attempts++
		result := s.testChatProbe(ctx, account, secret, started, prompt, candidate)
		if result.OK {
			return result, attempts
		}
		if !shouldTryAlternateChatModel(result.Message) {
			return result, attempts
		}
	}
	return TestResult{}, attempts
}

func shouldTryAlternateChatModel(message string) bool {
	lower := strings.ToLower(message)
	for _, blocked := range []string{"invalid api key", "unauthorized", "forbidden", "quota", "insufficient", "billing"} {
		if strings.Contains(lower, blocked) {
			return false
		}
	}
	for _, keyword := range []string{
		"no available channel", "no channel", "model_not_found", "model not found",
		"model does not exist", "unsupported model", "not support", "invalid model",
		"under group", "no route",
	} {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
}

func chatModelCandidates(models []string, failedModel string) []string {
	seen := map[string]bool{}
	candidates := make([]string, 0, len(models))
	for _, model := range models {
		name := strings.TrimSpace(model)
		key := strings.ToLower(name)
		if name == "" || seen[key] || isLikelyNonChatModel(name) || strings.EqualFold(name, failedModel) {
			continue
		}
		seen[key] = true
		candidates = append(candidates, name)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		leftScore := chatModelProbeScore(candidates[i])
		rightScore := chatModelProbeScore(candidates[j])
		if leftScore == rightScore {
			return strings.ToLower(candidates[i]) < strings.ToLower(candidates[j])
		}
		return leftScore > rightScore
	})
	return candidates
}

func chatModelProbeScore(model string) int {
	lower := strings.ToLower(strings.TrimSpace(model))
	score := 10
	for keyword, delta := range map[string]int{
		"mini": 32, "haiku": 30, "flash": 28, "lite": 26,
		"deepseek": 24, "qwen": 23, "glm": 22, "doubao": 21,
		"gpt": 20, "gemini": 19, "claude": 18, "moonshot": 17,
		"spark": 14, "sonnet": 10, "opus": 4,
	} {
		if strings.Contains(lower, keyword) {
			score += delta
		}
	}
	return score
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

func parseModels(body []byte) []string {
	seen := map[string]bool{}
	models := make([]string, 0)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		models = append(models, value)
	}
	addRaw := func(raw json.RawMessage) {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			add(text)
			return
		}
		var item map[string]any
		if json.Unmarshal(raw, &item) != nil {
			return
		}
		for _, key := range []string{"id", "model", "name"} {
			if text, ok := item[key].(string); ok {
				add(text)
				return
			}
		}
	}
	addRawArray := func(rawItems []json.RawMessage) {
		for _, raw := range rawItems {
			addRaw(raw)
		}
	}
	var parsed struct {
		Data   []json.RawMessage `json:"data"`
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		addRawArray(parsed.Data)
		addRawArray(parsed.Models)
	}
	if len(models) == 0 {
		var raw []json.RawMessage
		if json.Unmarshal(body, &raw) == nil {
			addRawArray(raw)
		}
	}
	sort.Strings(models)
	return models
}

func chooseDefaultChatModel(models []string, preferred string) string {
	preferred = strings.TrimSpace(preferred)
	if preferred != "" && !isLikelyNonChatModel(preferred) && modelAvailableOrUnknown(models, preferred) {
		return preferred
	}
	for _, model := range models {
		name := strings.TrimSpace(model)
		if name == "" || isLikelyNonChatModel(name) {
			continue
		}
		lower := strings.ToLower(name)
		for _, keyword := range []string{"gpt", "chat", "claude", "gemini", "deepseek", "qwen", "glm", "doubao", "moonshot", "yi-"} {
			if strings.Contains(lower, keyword) {
				return name
			}
		}
	}
	for _, model := range models {
		name := strings.TrimSpace(model)
		if name != "" && !isLikelyNonChatModel(name) {
			return name
		}
	}
	if len(models) > 0 {
		return strings.TrimSpace(models[0])
	}
	return preferred
}

func isLikelyNonChatModel(model string) bool {
	lower := strings.ToLower(strings.TrimSpace(model))
	if lower == "" {
		return false
	}
	for _, keyword := range []string{
		"embedding", "embed", "rerank", "ranker", "moderation",
		"tts", "whisper", "speech", "transcribe", "audio",
		"image", "dall-e", "dalle", "stable-diffusion", "sd-",
	} {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
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
	var availableModelsRaw []byte
	err := s.db.QueryRow(ctx, `
		SELECT id, provider_name, base_url, secret_fingerprint, chat_model, summary_model, embedding_model, available_models,
		       balance_supported, balance_endpoint, balance_cache_ttl_seconds, low_balance_threshold::float8,
		       enabled, last_test_at, last_test_status, last_used_at,
		       runtime_disabled_until, runtime_failure_count, runtime_last_error,
		       created_at, updated_at, secret_ciphertext_or_ref
		FROM im_ai_provider_account
		WHERE id = $1`, providerID).Scan(
		&item.ID, &item.ProviderName, &item.BaseURL, &item.SecretFingerprint, &item.ChatModel, &item.SummaryModel, &item.EmbeddingModel,
		&availableModelsRaw,
		&item.BalanceSupported, &item.BalanceEndpoint, &item.BalanceCacheTTLSeconds, &item.LowBalanceThreshold,
		&item.Enabled, &item.LastTestAt, &item.LastTestStatus, &item.LastUsedAt,
		&item.RuntimeDisabledUntil, &item.RuntimeFailureCount, &item.RuntimeLastError,
		&item.CreatedAt, &item.UpdatedAt, &ciphertext)
	if err != nil {
		return Account{}, "", err
	}
	_ = json.Unmarshal(availableModelsRaw, &item.AvailableModels)
	if item.AvailableModels == nil {
		item.AvailableModels = []string{}
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
	if strings.HasSuffix(strings.ToLower(baseURL), "/v1") && strings.HasPrefix(endpoint, "/api/") {
		baseURL = strings.TrimSuffix(baseURL, "/v1")
	}
	return strings.TrimRight(baseURL, "/") + endpoint, nil
}

func providerAPIURL(baseURL string, v1Path string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	path := "/" + strings.TrimLeft(strings.TrimSpace(v1Path), "/")
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		return base + path
	}
	return base + "/v1" + path
}

func parseBalance(body []byte) (float64, string, string) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return 0, "", "unknown"
	}
	currency := stringField(raw, "currency", "unit")
	for _, key := range []string{"balance", "remaining", "amount", "credit", "credits", "quota", "total_available", "available"} {
		if value, ok := numberField(raw, key); ok {
			return value, currency, key
		}
	}
	if data, ok := raw["data"].(map[string]any); ok {
		for _, key := range []string{"balance", "remaining", "amount", "credit", "credits", "quota", "total_available", "available"} {
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
