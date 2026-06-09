package fluapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const singletonID = 1

type Service struct {
	db           *pgxpool.Pool
	masterSecret string
	timeout      time.Duration
}

type storedConfig struct {
	Config
	passwordCiphertext string
	sessionCiphertext  string
}

func New(db *pgxpool.Pool, masterSecret string, timeout time.Duration) *Service {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &Service{
		db:           db,
		masterSecret: strings.TrimSpace(masterSecret),
		timeout:      timeout,
	}
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_fluapi_config (
			id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
			enabled BOOLEAN NOT NULL DEFAULT FALSE,
			base_url TEXT NOT NULL DEFAULT 'https://www.fluapi.com',
			username TEXT NOT NULL DEFAULT '',
			password_ciphertext TEXT NOT NULL DEFAULT '',
			session_ciphertext TEXT NOT NULL DEFAULT '',
			user_id TEXT NOT NULL DEFAULT '',
			quota_per_usd BIGINT NOT NULL DEFAULT 500000,
			low_balance_usd NUMERIC NOT NULL DEFAULT 10,
			last_login_at TIMESTAMP,
			last_sync_at TIMESTAMP,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_fluapi_balance_snapshot (
			id BIGSERIAL PRIMARY KEY,
			username TEXT NOT NULL DEFAULT '',
			user_id TEXT NOT NULL DEFAULT '',
			quota BIGINT NOT NULL DEFAULT 0,
			used_quota BIGINT NOT NULL DEFAULT 0,
			request_count BIGINT NOT NULL DEFAULT 0,
			balance_usd NUMERIC NOT NULL DEFAULT 0,
			used_usd NUMERIC NOT NULL DEFAULT 0,
			total_usd NUMERIC NOT NULL DEFAULT 0,
			low_balance BOOLEAN NOT NULL DEFAULT FALSE,
			raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			synced_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_fluapi_balance_synced ON im_ai_fluapi_balance_snapshot(synced_at DESC)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_fluapi_config (id, updated_at)
		VALUES (1, NOW())
		ON CONFLICT (id) DO NOTHING`)
	return err
}

func (s *Service) Status(ctx context.Context) (Status, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return Status{}, err
	}
	latest, err := s.LatestBalance(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return Status{}, err
	}
	if latest != nil && (cfg.LastSyncAt == nil || latest.SyncedAt.After(*cfg.LastSyncAt)) {
		cfg.LastSyncAt = &latest.SyncedAt
	}
	return Status{Config: cfg.Config, LatestBalance: latest}, nil
}

func (s *Service) SetConfig(ctx context.Context, cfg Config) (Status, error) {
	if s == nil || s.db == nil {
		return Status{}, errors.New("FluAPI usage service is not available")
	}
	baseURL, err := normalizeBaseURL(cfg.BaseURL)
	if err != nil {
		return Status{}, err
	}
	if cfg.QuotaPerUSD <= 0 {
		cfg.QuotaPerUSD = 500000
	}
	if cfg.LowBalanceUSD < 0 {
		cfg.LowBalanceUSD = 0
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO im_ai_fluapi_config (id, enabled, base_url, username, user_id, quota_per_usd, low_balance_usd, updated_at)
		VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
		ON CONFLICT (id) DO UPDATE
		SET enabled = EXCLUDED.enabled,
		    base_url = EXCLUDED.base_url,
		    username = EXCLUDED.username,
		    user_id = COALESCE(NULLIF(EXCLUDED.user_id, ''), im_ai_fluapi_config.user_id),
		    quota_per_usd = EXCLUDED.quota_per_usd,
		    low_balance_usd = EXCLUDED.low_balance_usd,
		    updated_at = NOW()`,
		cfg.Enabled, baseURL, strings.TrimSpace(cfg.Username), strings.TrimSpace(cfg.UserID), cfg.QuotaPerUSD, cfg.LowBalanceUSD)
	if err != nil {
		return Status{}, err
	}
	return s.Status(ctx)
}

func (s *Service) SetCredentials(ctx context.Context, req CredentialsRequest) (Status, error) {
	username := strings.TrimSpace(req.Username)
	password := strings.TrimSpace(req.Password)
	if username == "" || password == "" {
		return Status{}, errors.New("missing FluAPI username or password")
	}
	ciphertext, err := encryptSecret(s.masterSecret, password)
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "IM_AI_SECRET_KEY") {
			message = "服务器缺少 IM_AI_SECRET_KEY，无法加密保存 FluAPI 密码"
		}
		_ = s.setError(ctx, message)
		return Status{}, errors.New(message)
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO im_ai_fluapi_config (id, enabled, username, password_ciphertext, updated_at)
		VALUES (1, TRUE, $1, $2, NOW())
		ON CONFLICT (id) DO UPDATE
		SET enabled = TRUE,
		    username = EXCLUDED.username,
		    password_ciphertext = EXCLUDED.password_ciphertext,
		    updated_at = NOW()`, username, ciphertext)
	if err != nil {
		return Status{}, err
	}
	if _, err := s.Login(ctx); err != nil {
		return Status{}, err
	}
	return s.Status(ctx)
}

func (s *Service) Login(ctx context.Context) (Config, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(cfg.passwordCiphertext) == "" {
		message := "请先导入 FluAPI 控制台账号和密码"
		_ = s.setError(ctx, message)
		return Config{}, errors.New(message)
	}
	password, err := decryptSecret(s.masterSecret, cfg.passwordCiphertext)
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "IM_AI_SECRET_KEY") {
			message = "服务器缺少 IM_AI_SECRET_KEY，无法解密 FluAPI 密码"
		}
		_ = s.setError(ctx, message)
		return Config{}, errors.New(message)
	}
	session, userID, err := s.loginWithPassword(ctx, cfg.Config, password)
	if err != nil {
		_ = s.setError(ctx, err.Error())
		return Config{}, err
	}
	sessionCiphertext, err := encryptSecret(s.masterSecret, session)
	if err != nil {
		_ = s.setError(ctx, err.Error())
		return Config{}, err
	}
	err = s.db.QueryRow(ctx, `
		UPDATE im_ai_fluapi_config
		SET session_ciphertext = $1,
		    user_id = $2,
		    last_login_at = NOW(),
		    last_error = '',
		    updated_at = NOW()
		WHERE id = 1
		RETURNING enabled, base_url, username, user_id, quota_per_usd, low_balance_usd,
		          last_login_at, last_sync_at, last_error, updated_at,
		          password_ciphertext <> '', session_ciphertext <> ''`,
		sessionCiphertext, userID).Scan(
		&cfg.Enabled, &cfg.BaseURL, &cfg.Username, &cfg.UserID, &cfg.QuotaPerUSD, &cfg.LowBalanceUSD,
		&cfg.LastLoginAt, &cfg.LastSyncAt, &cfg.LastError, &cfg.UpdatedAt, &cfg.HasPassword, &cfg.HasSession)
	if err != nil {
		return Config{}, err
	}
	return cfg.Config, nil
}

func (s *Service) Sync(ctx context.Context) (BalanceSnapshot, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return BalanceSnapshot{}, err
	}
	if !cfg.Enabled {
		return BalanceSnapshot{}, errors.New("FluAPI usage sync is disabled")
	}
	session, err := decryptSecret(s.masterSecret, cfg.sessionCiphertext)
	if err != nil || strings.TrimSpace(session) == "" {
		if _, loginErr := s.Login(ctx); loginErr != nil {
			_ = s.setError(ctx, loginErr.Error())
			return BalanceSnapshot{}, loginErr
		}
		cfg, err = s.loadConfig(ctx)
		if err != nil {
			return BalanceSnapshot{}, err
		}
		session, err = decryptSecret(s.masterSecret, cfg.sessionCiphertext)
		if err != nil {
			return BalanceSnapshot{}, err
		}
	}
	snapshot, statusCode, err := s.fetchSelf(ctx, cfg.Config, session)
	if statusCode == http.StatusUnauthorized {
		if _, loginErr := s.Login(ctx); loginErr == nil {
			cfg, _ = s.loadConfig(ctx)
			session, _ = decryptSecret(s.masterSecret, cfg.sessionCiphertext)
			snapshot, statusCode, err = s.fetchSelf(ctx, cfg.Config, session)
		}
	}
	if err != nil {
		_ = s.setError(ctx, err.Error())
		return BalanceSnapshot{}, err
	}
	if statusCode < 200 || statusCode >= 300 {
		err := fmt.Errorf("FluAPI self status=%d", statusCode)
		_ = s.setError(ctx, err.Error())
		return BalanceSnapshot{}, err
	}
	raw, _ := json.Marshal(snapshot.raw)
	var saved BalanceSnapshot
	err = s.db.QueryRow(ctx, `
		INSERT INTO im_ai_fluapi_balance_snapshot (
			username, user_id, quota, used_quota, request_count,
			balance_usd, used_usd, total_usd, low_balance, raw_json, synced_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
		RETURNING id, username, user_id, quota, used_quota, request_count,
		          balance_usd::float8, used_usd::float8, total_usd::float8, low_balance, synced_at`,
		snapshot.Username, snapshot.UserID, snapshot.Quota, snapshot.UsedQuota, snapshot.RequestCount,
		snapshot.BalanceUSD, snapshot.UsedUSD, snapshot.TotalUSD, snapshot.LowBalance, string(raw)).Scan(
		&saved.ID, &saved.Username, &saved.UserID, &saved.Quota, &saved.UsedQuota, &saved.RequestCount,
		&saved.BalanceUSD, &saved.UsedUSD, &saved.TotalUSD, &saved.LowBalance, &saved.SyncedAt)
	if err != nil {
		return BalanceSnapshot{}, err
	}
	_, _ = s.db.Exec(ctx, `
		UPDATE im_ai_fluapi_config
		SET username = COALESCE(NULLIF($1, ''), username),
		    user_id = COALESCE(NULLIF($2, ''), user_id),
		    last_sync_at = $3,
		    last_error = '',
		    updated_at = NOW()
		WHERE id = 1`, saved.Username, saved.UserID, saved.SyncedAt)
	return saved, nil
}

func (s *Service) LatestBalance(ctx context.Context) (*BalanceSnapshot, error) {
	var item BalanceSnapshot
	err := s.db.QueryRow(ctx, `
		SELECT id, username, user_id, quota, used_quota, request_count,
		       balance_usd::float8, used_usd::float8, total_usd::float8, low_balance, synced_at
		FROM im_ai_fluapi_balance_snapshot
		ORDER BY synced_at DESC, id DESC
		LIMIT 1`).Scan(
		&item.ID, &item.Username, &item.UserID, &item.Quota, &item.UsedQuota, &item.RequestCount,
		&item.BalanceUSD, &item.UsedUSD, &item.TotalUSD, &item.LowBalance, &item.SyncedAt)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Service) loadConfig(ctx context.Context) (storedConfig, error) {
	cfg := storedConfig{}
	if s == nil || s.db == nil {
		return cfg, errors.New("FluAPI usage service is not available")
	}
	err := s.db.QueryRow(ctx, `
		SELECT enabled, base_url, username, password_ciphertext, session_ciphertext, user_id,
		       quota_per_usd, low_balance_usd::float8, last_login_at, last_sync_at, last_error, updated_at,
		       password_ciphertext <> '', session_ciphertext <> ''
		FROM im_ai_fluapi_config
		WHERE id = 1`).Scan(
		&cfg.Enabled, &cfg.BaseURL, &cfg.Username, &cfg.passwordCiphertext, &cfg.sessionCiphertext, &cfg.UserID,
		&cfg.QuotaPerUSD, &cfg.LowBalanceUSD, &cfg.LastLoginAt, &cfg.LastSyncAt, &cfg.LastError, &cfg.UpdatedAt,
		&cfg.HasPassword, &cfg.HasSession)
	if errors.Is(err, pgx.ErrNoRows) {
		cfg.Config = defaultConfig()
		return cfg, nil
	}
	if err != nil {
		return storedConfig{}, err
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://www.fluapi.com"
	}
	if cfg.QuotaPerUSD <= 0 {
		cfg.QuotaPerUSD = 500000
	}
	return cfg, nil
}

func defaultConfig() Config {
	return Config{
		Enabled:       false,
		BaseURL:       "https://www.fluapi.com",
		QuotaPerUSD:   500000,
		LowBalanceUSD: 10,
	}
}

func (s *Service) loginWithPassword(ctx context.Context, cfg Config, password string) (string, string, error) {
	if strings.TrimSpace(cfg.Username) == "" {
		return "", "", errors.New("missing FluAPI username")
	}
	baseURL, err := normalizeBaseURL(cfg.BaseURL)
	if err != nil {
		return "", "", err
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Timeout: s.timeout, Jar: jar}
	payload, _ := json.Marshal(map[string]string{
		"username": cfg.Username,
		"password": password,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/user/login?turnstile=", bytes.NewReader(payload))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return "", "", err
	}
	var parsed struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			ID         any    `json:"id"`
			Require2FA bool   `json:"require_2fa"`
			Username   string `json:"username"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", "", err
	}
	if !parsed.Success {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("FluAPI login failed status=%d", resp.StatusCode)
		}
		return "", "", errors.New(parsed.Message)
	}
	if parsed.Data.Require2FA {
		return "", "", errors.New("FluAPI account requires 2FA; please use a non-2FA service account or manual session mode")
	}
	parsedURL, _ := url.Parse(baseURL)
	session := ""
	for _, cookie := range jar.Cookies(parsedURL) {
		if cookie.Name == "session" {
			session = cookie.Value
			break
		}
	}
	if session == "" {
		return "", "", errors.New("FluAPI login did not return session cookie")
	}
	userID := stringify(parsed.Data.ID)
	return session, userID, nil
}

type selfSnapshot struct {
	BalanceSnapshot
	raw map[string]any
}

func (s *Service) fetchSelf(ctx context.Context, cfg Config, session string) (selfSnapshot, int, error) {
	baseURL, err := normalizeBaseURL(cfg.BaseURL)
	if err != nil {
		return selfSnapshot{}, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/user/self", nil)
	if err != nil {
		return selfSnapshot{}, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("New-Api-User", strings.TrimSpace(cfg.UserID))
	req.AddCookie(&http.Cookie{Name: "session", Value: session, Path: "/"})
	client := &http.Client{Timeout: s.timeout}
	resp, err := client.Do(req)
	if err != nil {
		return selfSnapshot{}, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return selfSnapshot{}, resp.StatusCode, err
	}
	var parsed struct {
		Success bool           `json:"success"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return selfSnapshot{}, resp.StatusCode, err
	}
	if !parsed.Success {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("FluAPI self status=%d", resp.StatusCode)
		}
		return selfSnapshot{}, resp.StatusCode, errors.New(parsed.Message)
	}
	quota := int64Field(parsed.Data, "quota")
	usedQuota := int64Field(parsed.Data, "used_quota")
	requestCount := int64Field(parsed.Data, "request_count")
	quotaPerUSD := cfg.QuotaPerUSD
	if quotaPerUSD <= 0 {
		quotaPerUSD = 500000
	}
	balanceUSD := float64(quota) / float64(quotaPerUSD)
	usedUSD := float64(usedQuota) / float64(quotaPerUSD)
	totalUSD := balanceUSD + usedUSD
	username := stringField(parsed.Data, "username")
	userID := stringify(parsed.Data["id"])
	if userID == "" {
		userID = cfg.UserID
	}
	return selfSnapshot{
		BalanceSnapshot: BalanceSnapshot{
			Username:     username,
			UserID:       userID,
			Quota:        quota,
			UsedQuota:    usedQuota,
			RequestCount: requestCount,
			BalanceUSD:   balanceUSD,
			UsedUSD:      usedUSD,
			TotalUSD:     totalUSD,
			LowBalance:   cfg.LowBalanceUSD > 0 && balanceUSD <= cfg.LowBalanceUSD,
		},
		raw: parsed.Data,
	}, resp.StatusCode, nil
}

func (s *Service) setError(ctx context.Context, message string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE im_ai_fluapi_config
		SET last_error = $1, updated_at = NOW()
		WHERE id = 1`, strings.TrimSpace(message))
	return err
}

func normalizeBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		value = "https://www.fluapi.com"
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid FluAPI base_url")
	}
	if strings.ToLower(parsed.Scheme) != "https" {
		return "", errors.New("FluAPI base_url must use https")
	}
	if isUnsafeHost(parsed.Hostname()) {
		return "", errors.New("FluAPI base_url host is not allowed")
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

func int64Field(raw map[string]any, key string) int64 {
	switch value := raw[key].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	case json.Number:
		parsed, err := value.Int64()
		if err == nil {
			return parsed
		}
	case string:
		var parsed int64
		_, _ = fmt.Sscanf(value, "%d", &parsed)
		return parsed
	}
	return 0
}

func stringField(raw map[string]any, key string) string {
	if value, ok := raw[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func stringify(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case float64:
		return fmt.Sprintf("%.0f", item)
	case int:
		return fmt.Sprintf("%d", item)
	case int64:
		return fmt.Sprintf("%d", item)
	case json.Number:
		return item.String()
	default:
		return ""
	}
}
