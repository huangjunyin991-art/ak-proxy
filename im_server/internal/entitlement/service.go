package entitlement

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var beijingLocation = time.FixedZone("Asia/Shanghai", 8*60*60)

type Service struct {
	db     *pgxpool.Pool
	secret string
}

type RedeemCodeCreateRequest struct {
	Tier         string `json:"tier"`
	DurationDays int    `json:"duration_days"`
	Count        int    `json:"count"`
	MaxUses      int    `json:"max_uses"`
	BindUsername string `json:"bind_username"`
	CreatedBy    string `json:"created_by"`
}

type RedeemCodeItem struct {
	ID           int64      `json:"id"`
	Code         string     `json:"code,omitempty"`
	Tier         string     `json:"tier"`
	TierName     string     `json:"tier_name"`
	DurationDays int        `json:"duration_days"`
	MaxUses      int        `json:"max_uses"`
	UsedCount    int        `json:"used_count"`
	BindUsername string     `json:"bind_username,omitempty"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	DisabledAt   *time.Time `json:"disabled_at,omitempty"`
	CreatedBy    string     `json:"created_by,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

func New(db *pgxpool.Pool, secret string) *Service {
	return &Service{db: db, secret: strings.TrimSpace(secret)}
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_tier_config (
			tier TEXT PRIMARY KEY,
			tier_name TEXT NOT NULL DEFAULT '',
			daily_limit INTEGER NOT NULL DEFAULT 0,
			monthly_limit INTEGER NOT NULL DEFAULT 0,
			priority INTEGER NOT NULL DEFAULT 0,
			memory_retention_days INTEGER NOT NULL DEFAULT 30,
			features JSONB NOT NULL DEFAULT '{}'::jsonb,
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_user_entitlement (
			username TEXT PRIMARY KEY,
			current_tier TEXT NOT NULL DEFAULT 'trial',
			current_started_at TIMESTAMP,
			current_expires_at TIMESTAMP,
			pending_tier TEXT NOT NULL DEFAULT '',
			pending_starts_at TIMESTAMP,
			pending_expires_at TIMESTAMP,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_redeem_code (
			id BIGSERIAL PRIMARY KEY,
			code_hash TEXT NOT NULL UNIQUE,
			tier TEXT NOT NULL,
			duration_days INTEGER NOT NULL DEFAULT 30,
			max_uses INTEGER NOT NULL DEFAULT 1,
			used_count INTEGER NOT NULL DEFAULT 0,
			bind_username TEXT NOT NULL DEFAULT '',
			starts_at TIMESTAMP,
			expires_at TIMESTAMP,
			disabled_at TIMESTAMP,
			created_by TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_redeem_record (
			id BIGSERIAL PRIMARY KEY,
			code_id BIGINT NOT NULL REFERENCES im_ai_redeem_code(id) ON DELETE CASCADE,
			username TEXT NOT NULL,
			tier TEXT NOT NULL,
			duration_days INTEGER NOT NULL DEFAULT 0,
			redeemed_at TIMESTAMP NOT NULL DEFAULT NOW(),
			client_ip TEXT NOT NULL DEFAULT '',
			user_agent TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_quota_daily_usage (
			username TEXT NOT NULL,
			quota_date DATE NOT NULL,
			feature_key TEXT NOT NULL,
			used_count INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			PRIMARY KEY (username, quota_date, feature_key)
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_quota_ledger (
			id BIGSERIAL PRIMARY KEY,
			username TEXT NOT NULL,
			feature_key TEXT NOT NULL,
			task_id TEXT NOT NULL DEFAULT '',
			delta INTEGER NOT NULL,
			reason TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_ai_quota_ledger_task_feature ON im_ai_quota_ledger(task_id, feature_key) WHERE task_id <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_redeem_record_username ON im_ai_redeem_record(username, redeemed_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_quota_ledger_username_created ON im_ai_quota_ledger(username, created_at DESC)`,
	}
	for index, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("entitlement schema statement #%d failed: %w", index+1, err)
		}
	}
	return s.ensureDefaultTiers(ctx)
}

func (s *Service) ensureDefaultTiers(ctx context.Context) error {
	defaults := []TierConfig{
		defaultTier(TierTrial, 5, 50, 0, 7, []string{FeatureAIChat}),
		defaultTier(TierBasic, 50, 1000, 1, 30, []string{FeatureAIChat, FeaturePolish}),
		defaultTier(TierAdvanced, 100, 2500, 2, 60, []string{FeatureAIChat, FeaturePolish, FeatureChatSummary, FeatureSemanticSearch}),
		defaultTier(TierHonor, 200, 5000, 3, 120, []string{FeatureAIChat, FeaturePolish, FeatureChatSummary, FeatureSemanticSearch, FeatureSearchSummary}),
		defaultTier(TierSupreme, 500, 15000, 4, 180, []string{FeatureAIChat, FeaturePolish, FeatureChatSummary, FeatureSemanticSearch, FeatureSearchSummary}),
	}
	for _, item := range defaults {
		featuresJSON, _ := json.Marshal(item.Features)
		if _, err := s.db.Exec(ctx, `
			INSERT INTO im_ai_tier_config (tier, tier_name, daily_limit, monthly_limit, priority, memory_retention_days, features, enabled, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE, NOW())
			ON CONFLICT (tier) DO NOTHING`,
			item.Tier, item.TierName, item.DailyLimit, item.MonthlyLimit, item.Priority, item.MemoryRetentionDays, string(featuresJSON)); err != nil {
			return err
		}
	}
	return nil
}

func defaultTier(tier string, daily int, monthly int, priority int, retentionDays int, enabledFeatures []string) TierConfig {
	features := map[string]bool{}
	for _, feature := range enabledFeatures {
		features[feature] = true
	}
	return TierConfig{
		Tier:                tier,
		TierName:            tierDisplayName(tier),
		DailyLimit:          daily,
		MonthlyLimit:        monthly,
		Priority:            priority,
		MemoryRetentionDays: retentionDays,
		Features:            features,
		Enabled:             true,
	}
}

func tierDisplayName(tier string) string {
	if value := tierNames[strings.ToLower(strings.TrimSpace(tier))]; value != "" {
		return value
	}
	return strings.TrimSpace(tier)
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeTier(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case TierBasic, "normal", "common":
		return TierBasic
	case TierAdvanced, "advance", "pro":
		return TierAdvanced
	case TierHonor:
		return TierHonor
	case TierSupreme, "ultimate":
		return TierSupreme
	default:
		return TierTrial
	}
}

func (s *Service) Snapshot(ctx context.Context, username string) (Snapshot, error) {
	return s.FeatureSnapshot(ctx, username, FeatureAIChat)
}

func (s *Service) FeatureSnapshot(ctx context.Context, username string, feature string) (Snapshot, error) {
	normalizedUsername := normalizeUsername(username)
	if normalizedUsername == "" {
		return Snapshot{}, errors.New("missing username")
	}
	tier, expiresAt, err := s.activeTier(ctx, normalizedUsername)
	if err != nil {
		return Snapshot{}, err
	}
	cfg, err := s.loadTierConfig(ctx, tier)
	if err != nil {
		return Snapshot{}, err
	}
	quota, err := s.quotaSnapshot(ctx, normalizedUsername, strings.TrimSpace(feature), cfg)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		Enabled:   cfg.Enabled,
		Tier:      cfg.Tier,
		TierName:  cfg.TierName,
		IsTrial:   cfg.Tier == TierTrial,
		ExpiresAt: expiresAt,
		Features:  cfg.Features,
		Priority:  cfg.Priority,
		Quota:     quota,
	}, nil
}

func (s *Service) activeTier(ctx context.Context, username string) (string, *time.Time, error) {
	var tier string
	var expiresAt *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT current_tier, current_expires_at
		FROM im_ai_user_entitlement
		WHERE username = $1`, username).Scan(&tier, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return TierTrial, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	tier = normalizeTier(tier)
	if expiresAt != nil && time.Now().After(*expiresAt) {
		return TierTrial, nil, nil
	}
	return tier, expiresAt, nil
}

func (s *Service) loadTierConfig(ctx context.Context, tier string) (TierConfig, error) {
	tier = normalizeTier(tier)
	var item TierConfig
	var featuresRaw []byte
	err := s.db.QueryRow(ctx, `
		SELECT tier, tier_name, daily_limit, monthly_limit, priority, memory_retention_days, features, enabled
		FROM im_ai_tier_config
		WHERE tier = $1`, tier).Scan(&item.Tier, &item.TierName, &item.DailyLimit, &item.MonthlyLimit, &item.Priority, &item.MemoryRetentionDays, &featuresRaw, &item.Enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		item = defaultTier(tier, 5, 50, 0, 7, []string{FeatureAIChat})
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return TierConfig{}, err
	}
	if item.TierName == "" {
		item.TierName = tierDisplayName(item.Tier)
	}
	item.Features = map[string]bool{}
	if len(featuresRaw) > 0 {
		_ = json.Unmarshal(featuresRaw, &item.Features)
	}
	if item.Features == nil {
		item.Features = map[string]bool{}
	}
	return item, nil
}

func (s *Service) quotaSnapshot(ctx context.Context, username string, feature string, cfg TierConfig) (QuotaSnapshot, error) {
	if feature == "" {
		feature = FeatureAIChat
	}
	now := time.Now().In(beijingLocation)
	quotaDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, beijingLocation)
	resetAt := quotaDate.Add(24 * time.Hour)
	var dailyUsed int
	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(used_count, 0)
		FROM im_ai_quota_daily_usage
		WHERE username = $1 AND quota_date = $2::date AND feature_key = $3`, username, quotaDate, feature).Scan(&dailyUsed)
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, beijingLocation)
	nextMonth := monthStart.AddDate(0, 1, 0)
	var monthlyUsed int
	if err := s.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(used_count), 0)
		FROM im_ai_quota_daily_usage
		WHERE username = $1 AND quota_date >= $2::date AND quota_date < $3::date AND feature_key = $4`,
		username, monthStart, nextMonth, feature).Scan(&monthlyUsed); err != nil {
		return QuotaSnapshot{}, err
	}
	return QuotaSnapshot{
		DailyLimit:       cfg.DailyLimit,
		DailyUsed:        dailyUsed,
		DailyRemaining:   remaining(cfg.DailyLimit, dailyUsed),
		MonthlyLimit:     cfg.MonthlyLimit,
		MonthlyUsed:      monthlyUsed,
		MonthlyRemaining: remaining(cfg.MonthlyLimit, monthlyUsed),
		ResetAt:          resetAt,
	}, nil
}

func remaining(limit int, used int) int {
	if limit <= 0 {
		return 0
	}
	value := limit - used
	if value < 0 {
		return 0
	}
	return value
}

func (s *Service) Precheck(ctx context.Context, username string, feature string) (PrecheckResult, error) {
	if feature == "" {
		feature = FeatureAIChat
	}
	snapshot, err := s.FeatureSnapshot(ctx, username, feature)
	if err != nil {
		return PrecheckResult{}, err
	}
	if !snapshot.Enabled {
		return PrecheckResult{Allowed: false, Code: "ai_disabled", Message: "AI service is disabled", Snapshot: snapshot}, nil
	}
	if !snapshot.Features[feature] {
		return PrecheckResult{Allowed: false, Code: "feature_disabled", Message: "This AI feature is not available for your current plan", Snapshot: snapshot}, nil
	}
	if snapshot.Quota.DailyRemaining <= 0 {
		return PrecheckResult{Allowed: false, Code: "quota_exhausted", Message: "Today's AI quota has been used up", Snapshot: snapshot}, nil
	}
	if snapshot.Quota.MonthlyLimit > 0 && snapshot.Quota.MonthlyRemaining <= 0 {
		return PrecheckResult{Allowed: false, Code: "monthly_quota_exhausted", Message: "This month's AI quota has been used up", Snapshot: snapshot}, nil
	}
	return PrecheckResult{Allowed: true, Snapshot: snapshot}, nil
}

func (s *Service) Consume(ctx context.Context, username string, feature string, taskID string, amount int, reason string) (Snapshot, error) {
	if amount <= 0 {
		amount = 1
	}
	if feature == "" {
		feature = FeatureAIChat
	}
	normalizedUsername := normalizeUsername(username)
	if normalizedUsername == "" {
		return Snapshot{}, errors.New("missing username")
	}
	now := time.Now().In(beijingLocation)
	quotaDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, beijingLocation)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `
		INSERT INTO im_ai_quota_ledger (username, feature_key, task_id, delta, reason, created_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT DO NOTHING`, normalizedUsername, feature, strings.TrimSpace(taskID), amount, strings.TrimSpace(reason))
	if err != nil {
		return Snapshot{}, err
	}
	if tag.RowsAffected() > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_ai_quota_daily_usage (username, quota_date, feature_key, used_count, updated_at)
			VALUES ($1, $2::date, $3, $4, NOW())
			ON CONFLICT (username, quota_date, feature_key)
			DO UPDATE SET used_count = im_ai_quota_daily_usage.used_count + EXCLUDED.used_count, updated_at = NOW()`,
			normalizedUsername, quotaDate, feature, amount); err != nil {
			return Snapshot{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Snapshot{}, err
	}
	return s.FeatureSnapshot(ctx, normalizedUsername, feature)
}

func (s *Service) Redeem(ctx context.Context, username string, code string, clientIP string, userAgent string) (RedeemResult, error) {
	normalizedUsername := normalizeUsername(username)
	normalizedCode := normalizeCode(code)
	if normalizedUsername == "" || normalizedCode == "" {
		return RedeemResult{}, errors.New("invalid redeem code")
	}
	codeHash := s.hashCode(normalizedCode)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RedeemResult{}, err
	}
	defer tx.Rollback(ctx)
	var id int64
	var tier string
	var durationDays int
	var maxUses int
	var usedCount int
	var bindUsername string
	var startsAt *time.Time
	var expiresAt *time.Time
	var disabledAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, tier, duration_days, max_uses, used_count, bind_username, starts_at, expires_at, disabled_at
		FROM im_ai_redeem_code
		WHERE code_hash = $1
		FOR UPDATE`, codeHash).Scan(&id, &tier, &durationDays, &maxUses, &usedCount, &bindUsername, &startsAt, &expiresAt, &disabledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RedeemResult{}, errors.New("redeem code not found")
	}
	if err != nil {
		return RedeemResult{}, err
	}
	now := time.Now()
	if disabledAt != nil {
		return RedeemResult{}, errors.New("redeem code disabled")
	}
	if startsAt != nil && now.Before(*startsAt) {
		return RedeemResult{}, errors.New("redeem code is not active yet")
	}
	if expiresAt != nil && now.After(*expiresAt) {
		return RedeemResult{}, errors.New("redeem code expired")
	}
	if strings.TrimSpace(bindUsername) != "" && normalizeUsername(bindUsername) != normalizedUsername {
		return RedeemResult{}, errors.New("redeem code is not available for this account")
	}
	if maxUses <= 0 {
		maxUses = 1
	}
	if usedCount >= maxUses {
		return RedeemResult{}, errors.New("redeem code already used")
	}
	tier = normalizeTier(tier)
	if durationDays <= 0 {
		durationDays = 30
	}
	newExpiresAt := now.AddDate(0, 0, durationDays)
	currentTier, currentExpiresAt, err := s.activeTier(ctx, normalizedUsername)
	if err != nil {
		return RedeemResult{}, err
	}
	currentCfg, _ := s.loadTierConfig(ctx, currentTier)
	newCfg, _ := s.loadTierConfig(ctx, tier)
	if currentExpiresAt != nil && currentCfg.Priority > newCfg.Priority {
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_ai_user_entitlement (username, current_tier, pending_tier, pending_starts_at, pending_expires_at, updated_at)
			VALUES ($1, 'trial', $2, $3, $4, NOW())
			ON CONFLICT (username) DO UPDATE
			SET pending_tier = EXCLUDED.pending_tier,
			    pending_starts_at = EXCLUDED.pending_starts_at,
			    pending_expires_at = EXCLUDED.pending_expires_at,
			    updated_at = NOW()`, normalizedUsername, tier, *currentExpiresAt, newExpiresAt); err != nil {
			return RedeemResult{}, err
		}
	} else {
		if currentTier == tier && currentExpiresAt != nil && currentExpiresAt.After(now) {
			newExpiresAt = currentExpiresAt.AddDate(0, 0, durationDays)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO im_ai_user_entitlement (username, current_tier, current_started_at, current_expires_at, updated_at)
			VALUES ($1, $2, NOW(), $3, NOW())
			ON CONFLICT (username) DO UPDATE
			SET current_tier = EXCLUDED.current_tier,
			    current_started_at = COALESCE(im_ai_user_entitlement.current_started_at, NOW()),
			    current_expires_at = EXCLUDED.current_expires_at,
			    updated_at = NOW()`, normalizedUsername, tier, newExpiresAt); err != nil {
			return RedeemResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE im_ai_redeem_code SET used_count = used_count + 1 WHERE id = $1`, id); err != nil {
		return RedeemResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_ai_redeem_record (code_id, username, tier, duration_days, redeemed_at, client_ip, user_agent)
		VALUES ($1, $2, $3, $4, NOW(), $5, $6)`, id, normalizedUsername, tier, durationDays, strings.TrimSpace(clientIP), strings.TrimSpace(userAgent)); err != nil {
		return RedeemResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RedeemResult{}, err
	}
	snapshot, err := s.Snapshot(ctx, normalizedUsername)
	if err != nil {
		return RedeemResult{}, err
	}
	return RedeemResult{Snapshot: snapshot, Message: "redeem success"}, nil
}

func normalizeCode(value string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
}

func (s *Service) hashCode(code string) string {
	secret := s.secret
	if secret == "" {
		secret = "ak-ai-redeem-dev-secret"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(normalizeCode(code)))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Service) CreateRedeemCodes(ctx context.Context, req RedeemCodeCreateRequest) ([]RedeemCodeItem, error) {
	tier := normalizeTier(req.Tier)
	count := req.Count
	if count <= 0 {
		count = 1
	}
	if count > 200 {
		count = 200
	}
	durationDays := req.DurationDays
	if durationDays <= 0 {
		durationDays = 30
	}
	maxUses := req.MaxUses
	if maxUses <= 0 {
		maxUses = 1
	}
	items := make([]RedeemCodeItem, 0, count)
	for i := 0; i < count; i++ {
		code, err := generateCode()
		if err != nil {
			return nil, err
		}
		var item RedeemCodeItem
		err = s.db.QueryRow(ctx, `
			INSERT INTO im_ai_redeem_code (code_hash, tier, duration_days, max_uses, bind_username, created_by, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			RETURNING id, tier, duration_days, max_uses, used_count, bind_username, expires_at, disabled_at, created_by, created_at`,
			s.hashCode(code), tier, durationDays, maxUses, normalizeUsername(req.BindUsername), strings.TrimSpace(req.CreatedBy)).
			Scan(&item.ID, &item.Tier, &item.DurationDays, &item.MaxUses, &item.UsedCount, &item.BindUsername, &item.ExpiresAt, &item.DisabledAt, &item.CreatedBy, &item.CreatedAt)
		if err != nil {
			return nil, err
		}
		item.Code = code
		item.TierName = tierDisplayName(item.Tier)
		items = append(items, item)
	}
	return items, nil
}

func generateCode() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	if len(encoded) > 20 {
		encoded = encoded[:20]
	}
	return "AI-" + encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12] + "-" + encoded[12:], nil
}

func (s *Service) ListRedeemCodes(ctx context.Context, limit int) ([]RedeemCodeItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, tier, duration_days, max_uses, used_count, bind_username, expires_at, disabled_at, created_by, created_at
		FROM im_ai_redeem_code
		ORDER BY id DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]RedeemCodeItem, 0)
	for rows.Next() {
		var item RedeemCodeItem
		if err := rows.Scan(&item.ID, &item.Tier, &item.DurationDays, &item.MaxUses, &item.UsedCount, &item.BindUsername, &item.ExpiresAt, &item.DisabledAt, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.TierName = tierDisplayName(item.Tier)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) ListTierConfigs(ctx context.Context) ([]TierConfig, error) {
	rows, err := s.db.Query(ctx, `
		SELECT tier, tier_name, daily_limit, monthly_limit, priority, memory_retention_days, features, enabled
		FROM im_ai_tier_config
		ORDER BY priority ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]TierConfig, 0)
	for rows.Next() {
		var item TierConfig
		var featuresRaw []byte
		if err := rows.Scan(&item.Tier, &item.TierName, &item.DailyLimit, &item.MonthlyLimit, &item.Priority, &item.MemoryRetentionDays, &featuresRaw, &item.Enabled); err != nil {
			return nil, err
		}
		item.Features = map[string]bool{}
		_ = json.Unmarshal(featuresRaw, &item.Features)
		if item.TierName == "" {
			item.TierName = tierDisplayName(item.Tier)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) UpsertTierConfig(ctx context.Context, item TierConfig) (TierConfig, error) {
	item.Tier = normalizeTier(item.Tier)
	if item.TierName == "" {
		item.TierName = tierDisplayName(item.Tier)
	}
	if item.Features == nil {
		item.Features = map[string]bool{FeatureAIChat: true}
	}
	featuresJSON, _ := json.Marshal(item.Features)
	err := s.db.QueryRow(ctx, `
		INSERT INTO im_ai_tier_config (tier, tier_name, daily_limit, monthly_limit, priority, memory_retention_days, features, enabled, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
		ON CONFLICT (tier) DO UPDATE
		SET tier_name = EXCLUDED.tier_name,
		    daily_limit = EXCLUDED.daily_limit,
		    monthly_limit = EXCLUDED.monthly_limit,
		    priority = EXCLUDED.priority,
		    memory_retention_days = EXCLUDED.memory_retention_days,
		    features = EXCLUDED.features,
		    enabled = EXCLUDED.enabled,
		    updated_at = NOW()
		RETURNING tier, tier_name, daily_limit, monthly_limit, priority, memory_retention_days, features, enabled`,
		item.Tier, item.TierName, item.DailyLimit, item.MonthlyLimit, item.Priority, item.MemoryRetentionDays, string(featuresJSON), item.Enabled).
		Scan(&item.Tier, &item.TierName, &item.DailyLimit, &item.MonthlyLimit, &item.Priority, &item.MemoryRetentionDays, &featuresJSON, &item.Enabled)
	if err != nil {
		return TierConfig{}, err
	}
	item.Features = map[string]bool{}
	_ = json.Unmarshal(featuresJSON, &item.Features)
	return item, nil
}
