package relayconsole

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
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

type storedAccount struct {
	Account
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
		client:       &http.Client{Timeout: timeout},
	}
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_relay_console_account (
			id BIGSERIAL PRIMARY KEY,
			adapter_key TEXT NOT NULL DEFAULT 'newapi',
			display_name TEXT NOT NULL DEFAULT 'Dream Field',
			console_base_url TEXT NOT NULL DEFAULT 'https://www.dreamfield.top',
			username TEXT NOT NULL DEFAULT '',
			password_ciphertext TEXT NOT NULL DEFAULT '',
			session_ciphertext TEXT NOT NULL DEFAULT '',
			user_id TEXT NOT NULL DEFAULT '',
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			low_balance_quota NUMERIC NOT NULL DEFAULT 0,
			last_login_at TIMESTAMP,
			last_sync_at TIMESTAMP,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_relay_console_balance_snapshot (
			id BIGSERIAL PRIMARY KEY,
			console_id BIGINT NOT NULL REFERENCES im_ai_relay_console_account(id) ON DELETE CASCADE,
			adapter_key TEXT NOT NULL DEFAULT 'newapi',
			display_name TEXT NOT NULL DEFAULT '',
			username TEXT NOT NULL DEFAULT '',
			user_id TEXT NOT NULL DEFAULT '',
			token_ref TEXT NOT NULL DEFAULT '',
			token_name TEXT NOT NULL DEFAULT '',
			total_granted NUMERIC NOT NULL DEFAULT 0,
			total_used NUMERIC NOT NULL DEFAULT 0,
			total_available NUMERIC NOT NULL DEFAULT 0,
			unlimited_quota BOOLEAN NOT NULL DEFAULT FALSE,
			low_balance BOOLEAN NOT NULL DEFAULT FALSE,
			raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			synced_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_relay_console_balance_synced ON im_ai_relay_console_balance_snapshot(console_id, synced_at DESC)`,
	}
	for index, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("relay console schema statement #%d failed: %w", index+1, err)
		}
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_relay_console_account (adapter_key, display_name, console_base_url, enabled, updated_at)
		SELECT 'newapi', 'Dream Field', 'https://www.dreamfield.top', TRUE, NOW()
		WHERE NOT EXISTS (SELECT 1 FROM im_ai_relay_console_account)`)
	return err
}

func (s *Service) Status(ctx context.Context) (Status, error) {
	accounts, err := s.ListAccounts(ctx)
	if err != nil {
		return Status{}, err
	}
	latest, err := s.LatestBalance(ctx, 0)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return Status{}, err
	}
	latestByAccount := make(map[int64]BalanceSnapshot)
	for _, account := range accounts {
		item, itemErr := s.LatestBalance(ctx, account.ID)
		if itemErr == nil && item != nil {
			latestByAccount[account.ID] = *item
		}
	}
	return Status{Accounts: accounts, LatestBalance: latest, LatestBalances: latestByAccount}, nil
}

func (s *Service) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, adapter_key, display_name, console_base_url, username, user_id, enabled,
		       low_balance_quota::float8, last_login_at, last_sync_at, last_error, updated_at,
		       password_ciphertext <> '', session_ciphertext <> ''
		FROM im_ai_relay_console_account
		ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Account, 0)
	for rows.Next() {
		var item Account
		if err := rows.Scan(
			&item.ID, &item.AdapterKey, &item.DisplayName, &item.ConsoleBaseURL, &item.Username, &item.UserID, &item.Enabled,
			&item.LowBalanceQuota, &item.LastLoginAt, &item.LastSyncAt, &item.LastError, &item.UpdatedAt,
			&item.HasPassword, &item.HasSession,
		); err != nil {
			return nil, err
		}
		item = normalizeAccount(item)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) GetAccount(ctx context.Context, consoleID int64) (Account, error) {
	account, err := s.loadAccount(ctx, consoleID)
	if err != nil {
		return Account{}, err
	}
	return account.Account, nil
}

func (s *Service) UpsertAccount(ctx context.Context, item Account) (Account, error) {
	item = normalizeAccount(item)
	baseURL, err := normalizeConsoleBaseURL(item.ConsoleBaseURL, item.AdapterKey)
	if err != nil {
		return Account{}, err
	}
	if adapterByKey(item.AdapterKey) == nil {
		return Account{}, errors.New("unsupported relay console adapter")
	}
	if item.ID > 0 {
		row := s.db.QueryRow(ctx, `
			UPDATE im_ai_relay_console_account
			SET adapter_key = $2, display_name = $3, console_base_url = $4, username = $5,
			    user_id = COALESCE(NULLIF($6, ''), user_id), enabled = $7,
			    low_balance_quota = $8, updated_at = NOW()
			WHERE id = $1
			RETURNING id, adapter_key, display_name, console_base_url, username, user_id, enabled,
			       low_balance_quota::float8, last_login_at, last_sync_at, last_error, updated_at,
			       password_ciphertext <> '', session_ciphertext <> ''`,
			item.ID, item.AdapterKey, item.DisplayName, baseURL, strings.TrimSpace(item.Username),
			strings.TrimSpace(item.UserID), item.Enabled, item.LowBalanceQuota)
		return scanAccount(row)
	}
	row := s.db.QueryRow(ctx, `
		INSERT INTO im_ai_relay_console_account (adapter_key, display_name, console_base_url, username, user_id, enabled, low_balance_quota, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		RETURNING id, adapter_key, display_name, console_base_url, username, user_id, enabled,
		       low_balance_quota::float8, last_login_at, last_sync_at, last_error, updated_at,
		       password_ciphertext <> '', session_ciphertext <> ''`,
		item.AdapterKey, item.DisplayName, baseURL, strings.TrimSpace(item.Username), strings.TrimSpace(item.UserID),
		item.Enabled, item.LowBalanceQuota)
	return scanAccount(row)
}

func (s *Service) SetCredentials(ctx context.Context, consoleID int64, req CredentialsRequest) (Account, error) {
	username := strings.TrimSpace(req.Username)
	password := strings.TrimSpace(req.Password)
	if username == "" || password == "" {
		return Account{}, errors.New("missing relay console username or password")
	}
	account, err := s.loadAccount(ctx, consoleID)
	if err != nil {
		return Account{}, err
	}
	ciphertext, err := encryptSecret(s.masterSecret, password)
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "IM_AI_SECRET_KEY") {
			message = "服务器缺少 IM_AI_SECRET_KEY，无法加密保存中转站控制台密码"
		}
		_ = s.setError(ctx, consoleID, message)
		return Account{}, errors.New(message)
	}
	_, err = s.db.Exec(ctx, `
		UPDATE im_ai_relay_console_account
		SET username = $2, password_ciphertext = $3, enabled = TRUE, updated_at = NOW()
		WHERE id = $1`, consoleID, username, ciphertext)
	if err != nil {
		return Account{}, err
	}
	account.Username = username
	return s.Login(ctx, account.ID)
}

func (s *Service) Login(ctx context.Context, consoleID int64) (Account, error) {
	account, err := s.loadAccount(ctx, consoleID)
	if err != nil {
		return Account{}, err
	}
	if strings.TrimSpace(account.passwordCiphertext) == "" {
		message := "请先填写中转站控制台账号和密码"
		_ = s.setError(ctx, consoleID, message)
		return Account{}, errors.New(message)
	}
	password, err := decryptSecret(s.masterSecret, account.passwordCiphertext)
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "IM_AI_SECRET_KEY") {
			message = "服务器缺少 IM_AI_SECRET_KEY，无法解密中转站控制台密码"
		}
		_ = s.setError(ctx, consoleID, message)
		return Account{}, errors.New(message)
	}
	adapter := adapterByKey(account.AdapterKey)
	if adapter == nil {
		return Account{}, errors.New("unsupported relay console adapter")
	}
	session, err := adapter.Login(ctx, s.client, account.Account, password)
	if err != nil {
		_ = s.setError(ctx, consoleID, err.Error())
		return Account{}, err
	}
	rawSession, _ := json.Marshal(session)
	sessionCiphertext, err := encryptSecret(s.masterSecret, string(rawSession))
	if err != nil {
		_ = s.setError(ctx, consoleID, err.Error())
		return Account{}, err
	}
	row := s.db.QueryRow(ctx, `
		UPDATE im_ai_relay_console_account
		SET session_ciphertext = $2, user_id = $3, last_login_at = NOW(), last_error = '', updated_at = NOW()
		WHERE id = $1
		RETURNING id, adapter_key, display_name, console_base_url, username, user_id, enabled,
		       low_balance_quota::float8, last_login_at, last_sync_at, last_error, updated_at,
		       password_ciphertext <> '', session_ciphertext <> ''`,
		consoleID, sessionCiphertext, strings.TrimSpace(session.UserID))
	return scanAccount(row)
}

func (s *Service) ListTokens(ctx context.Context, consoleID int64) (TokenList, error) {
	account, session, err := s.accountSession(ctx, consoleID)
	if err != nil {
		return TokenList{}, err
	}
	adapter := adapterByKey(account.AdapterKey)
	if adapter == nil {
		return TokenList{}, errors.New("unsupported relay console adapter")
	}
	tokens, err := adapter.ListTokens(ctx, s.client, account.Account, session)
	if err != nil && looksUnauthorized(err) {
		if _, loginErr := s.Login(ctx, consoleID); loginErr == nil {
			account, session, _ = s.accountSession(ctx, consoleID)
			tokens, err = adapter.ListTokens(ctx, s.client, account.Account, session)
		}
	}
	if err != nil {
		_ = s.setError(ctx, consoleID, err.Error())
		return TokenList{}, err
	}
	var usage *AccountUsage
	if accountUsage, usageErr := adapter.FetchAccountUsage(ctx, s.client, account.Account, session); usageErr == nil {
		accountUsage.ConsoleID = consoleID
		usage = &accountUsage
	}
	availableModels := []string{}
	if modelAdapter, ok := adapter.(interface {
		FetchConsoleModels(context.Context, *http.Client, Account, Session) ([]string, error)
	}); ok {
		if models, modelErr := modelAdapter.FetchConsoleModels(ctx, s.client, account.Account, session); modelErr == nil {
			availableModels = models
		}
	}
	return TokenList{ConsoleID: consoleID, Tokens: tokens, AvailableModels: availableModels, AccountUsage: usage}, nil
}

func (s *Service) FetchTokenKey(ctx context.Context, consoleID int64, tokenID string) (string, TokenInfo, error) {
	account, session, err := s.accountSession(ctx, consoleID)
	if err != nil {
		return "", TokenInfo{}, err
	}
	adapter := adapterByKey(account.AdapterKey)
	if adapter == nil {
		return "", TokenInfo{}, errors.New("unsupported relay console adapter")
	}
	var token TokenInfo
	if tokens, listErr := adapter.ListTokens(ctx, s.client, account.Account, session); listErr == nil {
		for _, item := range tokens {
			if strings.EqualFold(item.ID, strings.TrimSpace(tokenID)) {
				token = item
				break
			}
		}
	}
	key, err := adapter.FetchTokenKey(ctx, s.client, account.Account, session, tokenID)
	if err != nil && looksUnauthorized(err) {
		if _, loginErr := s.Login(ctx, consoleID); loginErr == nil {
			account, session, _ = s.accountSession(ctx, consoleID)
			key, err = adapter.FetchTokenKey(ctx, s.client, account.Account, session, tokenID)
		}
	}
	if err != nil {
		_ = s.setError(ctx, consoleID, err.Error())
		return "", TokenInfo{}, err
	}
	return key, token, nil
}

func (s *Service) ListModels(ctx context.Context, consoleID int64, tokenID string) (ModelList, error) {
	tokenID = strings.TrimSpace(tokenID)
	if tokenID == "" {
		return ModelList{}, errors.New("missing token_id")
	}
	account, err := s.loadAccount(ctx, consoleID)
	if err != nil {
		return ModelList{}, err
	}
	adapter := adapterByKey(account.AdapterKey)
	if adapter == nil {
		return ModelList{}, errors.New("unsupported relay console adapter")
	}
	key, _, err := s.FetchTokenKey(ctx, consoleID, tokenID)
	if err != nil {
		return ModelList{}, err
	}
	models, err := adapter.FetchModels(ctx, s.client, account.Account, key)
	if err != nil {
		_ = s.setError(ctx, consoleID, err.Error())
		return ModelList{}, err
	}
	return ModelList{ConsoleID: consoleID, TokenID: tokenID, Models: models}, nil
}

func (s *Service) Sync(ctx context.Context, consoleID int64, tokenID string) (BalanceSnapshot, error) {
	account, err := s.loadAccount(ctx, consoleID)
	if err != nil {
		return BalanceSnapshot{}, err
	}
	adapter := adapterByKey(account.AdapterKey)
	if adapter == nil {
		return BalanceSnapshot{}, errors.New("unsupported relay console adapter")
	}
	key, token, err := s.FetchTokenKey(ctx, consoleID, tokenID)
	if err != nil {
		return BalanceSnapshot{}, err
	}
	_, session, err := s.accountSession(ctx, consoleID)
	if err != nil {
		return BalanceSnapshot{}, err
	}
	usage, err := adapter.FetchTokenUsage(ctx, s.client, account.Account, session, key)
	if err != nil {
		_ = s.setError(ctx, consoleID, err.Error())
		return BalanceSnapshot{}, err
	}
	tokenName := strings.TrimSpace(token.Name)
	if tokenName == "" {
		tokenName = usage.TokenName
	}
	raw, _ := json.Marshal(usage.Raw)
	lowBalance := account.LowBalanceQuota > 0 && !usage.UnlimitedQuota && usage.TotalAvailable <= account.LowBalanceQuota
	var saved BalanceSnapshot
	err = s.db.QueryRow(ctx, `
		INSERT INTO im_ai_relay_console_balance_snapshot (
			console_id, adapter_key, display_name, username, user_id, token_ref, token_name,
			total_granted, total_used, total_available, unlimited_quota, low_balance, raw_json, synced_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())
		RETURNING id, console_id, adapter_key, display_name, username, user_id, token_ref, token_name,
		          total_granted::float8, total_used::float8, total_available::float8, unlimited_quota, low_balance, synced_at`,
		account.ID, account.AdapterKey, account.DisplayName, account.Username, account.UserID, strings.TrimSpace(tokenID), tokenName,
		usage.TotalGranted, usage.TotalUsed, usage.TotalAvailable, usage.UnlimitedQuota, lowBalance, string(raw)).Scan(
		&saved.ID, &saved.ConsoleID, &saved.AdapterKey, &saved.DisplayName, &saved.Username, &saved.UserID, &saved.TokenRef, &saved.TokenName,
		&saved.TotalGranted, &saved.TotalUsed, &saved.TotalAvailable, &saved.UnlimitedQuota, &saved.LowBalance, &saved.SyncedAt)
	if err != nil {
		return BalanceSnapshot{}, err
	}
	_, _ = s.db.Exec(ctx, `
		UPDATE im_ai_relay_console_account
		SET last_sync_at = $2, last_error = '', updated_at = NOW()
		WHERE id = $1`, account.ID, saved.SyncedAt)
	return saved, nil
}

func (s *Service) LatestBalance(ctx context.Context, consoleID int64) (*BalanceSnapshot, error) {
	query := `
		SELECT id, console_id, adapter_key, display_name, username, user_id, token_ref, token_name,
		       total_granted::float8, total_used::float8, total_available::float8, unlimited_quota, low_balance, synced_at
		FROM im_ai_relay_console_balance_snapshot`
	args := []any{}
	if consoleID > 0 {
		query += ` WHERE console_id = $1`
		args = append(args, consoleID)
	}
	query += ` ORDER BY synced_at DESC, id DESC LIMIT 1`
	var item BalanceSnapshot
	err := s.db.QueryRow(ctx, query, args...).Scan(
		&item.ID, &item.ConsoleID, &item.AdapterKey, &item.DisplayName, &item.Username, &item.UserID, &item.TokenRef, &item.TokenName,
		&item.TotalGranted, &item.TotalUsed, &item.TotalAvailable, &item.UnlimitedQuota, &item.LowBalance, &item.SyncedAt)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Service) loadAccount(ctx context.Context, consoleID int64) (storedAccount, error) {
	if s == nil || s.db == nil {
		return storedAccount{}, errors.New("relay console service is not available")
	}
	if consoleID <= 0 {
		return storedAccount{}, errors.New("invalid relay console id")
	}
	var item storedAccount
	err := s.db.QueryRow(ctx, `
		SELECT id, adapter_key, display_name, console_base_url, username, user_id, enabled,
		       low_balance_quota::float8, last_login_at, last_sync_at, last_error, updated_at,
		       password_ciphertext, session_ciphertext,
		       password_ciphertext <> '', session_ciphertext <> ''
		FROM im_ai_relay_console_account
		WHERE id = $1`, consoleID).Scan(
		&item.ID, &item.AdapterKey, &item.DisplayName, &item.ConsoleBaseURL, &item.Username, &item.UserID, &item.Enabled,
		&item.LowBalanceQuota, &item.LastLoginAt, &item.LastSyncAt, &item.LastError, &item.UpdatedAt,
		&item.passwordCiphertext, &item.sessionCiphertext, &item.HasPassword, &item.HasSession)
	if err != nil {
		return storedAccount{}, err
	}
	item.Account = normalizeAccount(item.Account)
	return item, nil
}

func (s *Service) accountSession(ctx context.Context, consoleID int64) (storedAccount, Session, error) {
	account, err := s.loadAccount(ctx, consoleID)
	if err != nil {
		return storedAccount{}, Session{}, err
	}
	if !account.Enabled {
		return storedAccount{}, Session{}, errors.New("relay console is disabled")
	}
	if strings.TrimSpace(account.sessionCiphertext) == "" {
		if _, loginErr := s.Login(ctx, consoleID); loginErr != nil {
			return storedAccount{}, Session{}, loginErr
		}
		account, err = s.loadAccount(ctx, consoleID)
		if err != nil {
			return storedAccount{}, Session{}, err
		}
	}
	plain, err := decryptSecret(s.masterSecret, account.sessionCiphertext)
	if err != nil {
		if _, loginErr := s.Login(ctx, consoleID); loginErr != nil {
			return storedAccount{}, Session{}, loginErr
		}
		account, err = s.loadAccount(ctx, consoleID)
		if err != nil {
			return storedAccount{}, Session{}, err
		}
		plain, err = decryptSecret(s.masterSecret, account.sessionCiphertext)
	}
	if err != nil {
		return storedAccount{}, Session{}, err
	}
	var session Session
	if err := json.Unmarshal([]byte(plain), &session); err != nil {
		return storedAccount{}, Session{}, err
	}
	if session.UserID == "" {
		session.UserID = account.UserID
	}
	return account, session, nil
}

func scanAccount(row pgx.Row) (Account, error) {
	var item Account
	err := row.Scan(
		&item.ID, &item.AdapterKey, &item.DisplayName, &item.ConsoleBaseURL, &item.Username, &item.UserID, &item.Enabled,
		&item.LowBalanceQuota, &item.LastLoginAt, &item.LastSyncAt, &item.LastError, &item.UpdatedAt,
		&item.HasPassword, &item.HasSession,
	)
	if err != nil {
		return Account{}, err
	}
	return normalizeAccount(item), nil
}

func normalizeAccount(item Account) Account {
	item.AdapterKey = strings.ToLower(strings.TrimSpace(item.AdapterKey))
	if item.AdapterKey == "" {
		item.AdapterKey = AdapterNewAPI
	}
	item.AdapterLabel = adapterLabel(item.AdapterKey)
	if strings.TrimSpace(item.DisplayName) == "" {
		item.DisplayName = item.AdapterLabel
	}
	if strings.TrimSpace(item.ConsoleBaseURL) == "" {
		if adapter := adapterByKey(item.AdapterKey); adapter != nil {
			item.ConsoleBaseURL = adapter.DefaultBaseURL()
		}
	}
	if item.LowBalanceQuota < 0 {
		item.LowBalanceQuota = 0
	}
	return item
}

func (s *Service) setError(ctx context.Context, consoleID int64, message string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE im_ai_relay_console_account
		SET last_error = $2, updated_at = NOW()
		WHERE id = $1`, consoleID, strings.TrimSpace(message))
	return err
}

func normalizeConsoleBaseURL(value string, adapterKey string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		if adapter := adapterByKey(adapterKey); adapter != nil {
			value = adapter.DefaultBaseURL()
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid relay console base_url")
	}
	if strings.ToLower(parsed.Scheme) != "https" {
		return "", errors.New("relay console base_url must use https")
	}
	if isUnsafeHost(parsed.Hostname()) {
		return "", errors.New("relay console base_url host is not allowed")
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

func looksUnauthorized(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unauthorized") || strings.Contains(message, "status=401") || strings.Contains(message, "status=403")
}

func parseNewAPITokens(raw json.RawMessage) []TokenInfo {
	var page struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(raw, &page); err == nil && len(page.Items) > 0 {
		return tokenMaps(page.Items)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err == nil {
		return tokenMaps(rows)
	}
	return []TokenInfo{}
}

func tokenMaps(rows []map[string]any) []TokenInfo {
	items := make([]TokenInfo, 0, len(rows))
	for _, row := range rows {
		id := stringify(row["id"])
		if id == "" {
			continue
		}
		items = append(items, TokenInfo{
			ID:                 id,
			Name:               stringField(row, "name"),
			Status:             int(float64Field(row, "status")),
			Group:              stringField(row, "group"),
			KeyMasked:          stringField(row, "key"),
			RemainQuota:        float64Field(row, "remain_quota"),
			UsedQuota:          float64Field(row, "used_quota"),
			UnlimitedQuota:     boolField(row, "unlimited_quota"),
			ModelLimitsEnabled: boolField(row, "model_limits_enabled"),
			ExpiredTime:        int64(float64Field(row, "expired_time")),
		})
	}
	return items
}

func parseNewAPIModels(body []byte) []string {
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil && len(parsed.Data) > 0 {
		models := make([]string, 0, len(parsed.Data))
		seen := map[string]struct{}{}
		for _, item := range parsed.Data {
			model := strings.TrimSpace(item.ID)
			if model == "" {
				continue
			}
			key := strings.ToLower(model)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			models = append(models, model)
		}
		return models
	}
	var fallback struct {
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(body, &fallback); err == nil {
		return fallback.Models
	}
	return []string{}
}

func stringify(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case float64:
		if item == float64(int64(item)) {
			return strconv.FormatInt(int64(item), 10)
		}
		return strconv.FormatFloat(item, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(item, 10)
	case int:
		return strconv.Itoa(item)
	case json.Number:
		return item.String()
	default:
		return strings.TrimSpace(fmt.Sprint(item))
	}
}

func float64Field(raw map[string]any, key string) float64 {
	switch value := raw[key].(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case json.Number:
		parsed, err := value.Float64()
		if err == nil {
			return parsed
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func stringField(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := raw[key].(string); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func boolField(raw map[string]any, key string) bool {
	switch value := raw[key].(type) {
	case bool:
		return value
	case string:
		return strings.EqualFold(strings.TrimSpace(value), "true")
	default:
		return false
	}
}
