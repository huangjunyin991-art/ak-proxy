package billing

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const runtimeConfigKey = "runtime"

var beijingLocation = time.FixedZone("Asia/Shanghai", 8*60*60)

type Service struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_ai_billing_config (
			key TEXT PRIMARY KEY,
			value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_ai_billing_ledger (
			id BIGSERIAL PRIMARY KEY,
			task_id TEXT NOT NULL DEFAULT '',
			username TEXT NOT NULL,
			feature_key TEXT NOT NULL DEFAULT 'ai_chat',
			model TEXT NOT NULL DEFAULT '',
			provider_id BIGINT NOT NULL DEFAULT 0,
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			estimated_tokens INTEGER NOT NULL DEFAULT 0,
			upstream_request_id TEXT NOT NULL DEFAULT '',
			upstream_quota_delta BIGINT NOT NULL DEFAULT 0,
			upstream_cost_usd_micros BIGINT NOT NULL DEFAULT 0,
			user_charge_units BIGINT NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'settled',
			reason TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			settled_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_ai_billing_ledger_task_feature ON im_ai_billing_ledger(task_id, feature_key) WHERE task_id <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_billing_ledger_username_created ON im_ai_billing_ledger(username, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_ai_billing_ledger_status_created ON im_ai_billing_ledger(status, created_at DESC)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func defaultConfig() Config {
	return Config{
		Enabled:              true,
		UnitLabel:            "AI额度",
		UserUnitsPer1KTokens: 1,
		DefaultMarkup:        1,
		MinimumChargeUnits:   1,
		TierMonthlyCreditUnits: map[string]int64{
			"trial":    50,
			"basic":    1000,
			"advanced": 2500,
			"honor":    5000,
			"supreme":  15000,
		},
	}
}

func normalizeConfig(cfg Config) Config {
	def := defaultConfig()
	if cfg.UnitLabel == "" {
		cfg.UnitLabel = def.UnitLabel
	}
	if cfg.UserUnitsPer1KTokens <= 0 {
		cfg.UserUnitsPer1KTokens = def.UserUnitsPer1KTokens
	}
	if cfg.DefaultMarkup <= 0 {
		cfg.DefaultMarkup = def.DefaultMarkup
	}
	if cfg.MinimumChargeUnits < 0 {
		cfg.MinimumChargeUnits = def.MinimumChargeUnits
	}
	if cfg.TierMonthlyCreditUnits == nil {
		cfg.TierMonthlyCreditUnits = def.TierMonthlyCreditUnits
	}
	for tier, value := range def.TierMonthlyCreditUnits {
		if _, ok := cfg.TierMonthlyCreditUnits[tier]; !ok {
			cfg.TierMonthlyCreditUnits[tier] = value
		}
	}
	return cfg
}

func (s *Service) Config(ctx context.Context) (Config, error) {
	cfg := defaultConfig()
	if s == nil || s.db == nil {
		return cfg, nil
	}
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT value_json FROM im_ai_billing_config WHERE key = $1`, runtimeConfigKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg, nil
	}
	if err != nil {
		return Config{}, err
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &cfg)
	}
	return normalizeConfig(cfg), nil
}

func (s *Service) SetConfig(ctx context.Context, cfg Config) (Config, error) {
	if s == nil || s.db == nil {
		return Config{}, errors.New("AI billing service is not available")
	}
	cfg = normalizeConfig(cfg)
	raw, _ := json.Marshal(cfg)
	_, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_billing_config (key, value_json, updated_at)
		VALUES ($1, $2::jsonb, NOW())
		ON CONFLICT (key) DO UPDATE
		SET value_json = EXCLUDED.value_json,
		    updated_at = NOW()`, runtimeConfigKey, string(raw))
	if err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (s *Service) Precheck(ctx context.Context, username string, tier string) (PrecheckResult, error) {
	snapshot, err := s.Snapshot(ctx, username, tier)
	if err != nil {
		return PrecheckResult{}, err
	}
	if !snapshot.Enabled {
		return PrecheckResult{Allowed: true, Snapshot: snapshot}, nil
	}
	if snapshot.MonthlyLimitUnits > 0 && snapshot.MonthlyRemainingUnits <= 0 {
		return PrecheckResult{
			Allowed:  false,
			Code:     "billing_quota_exhausted",
			Message:  "本月 AI 额度已用完，本次没有消耗额度。",
			Snapshot: snapshot,
		}, nil
	}
	return PrecheckResult{Allowed: true, Snapshot: snapshot}, nil
}

func (s *Service) Snapshot(ctx context.Context, username string, tier string) (Snapshot, error) {
	cfg, err := s.Config(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	tier = normalizeTier(tier)
	username = normalizeUsername(username)
	monthStart, nextMonth, resetAt := currentMonthRange()
	used := int64(0)
	if s != nil && s.db != nil && username != "" {
		if err := s.db.QueryRow(ctx, `
			SELECT COALESCE(SUM(user_charge_units), 0)
			FROM im_ai_billing_ledger
			WHERE username = $1
			  AND status = $2
			  AND created_at >= $3
			  AND created_at < $4`, username, StatusSettled, monthStart, nextMonth).Scan(&used); err != nil {
			return Snapshot{}, err
		}
	}
	limit := cfg.TierMonthlyCreditUnits[tier]
	remaining := limit - used
	if limit <= 0 {
		remaining = 0
	} else if remaining < 0 {
		remaining = 0
	}
	last, _ := s.LastCharge(ctx, username)
	return Snapshot{
		Enabled:               cfg.Enabled,
		UnitLabel:             cfg.UnitLabel,
		Tier:                  tier,
		MonthlyLimitUnits:     limit,
		MonthlyUsedUnits:      used,
		MonthlyRemainingUnits: remaining,
		ResetAt:               resetAt,
		LastCharge:            last,
	}, nil
}

func (s *Service) Settle(ctx context.Context, item Settlement) (LedgerItem, error) {
	if s == nil || s.db == nil {
		return LedgerItem{}, errors.New("AI billing service is not available")
	}
	item.Username = normalizeUsername(item.Username)
	item.FeatureKey = strings.TrimSpace(item.FeatureKey)
	if item.FeatureKey == "" {
		item.FeatureKey = FeatureAIChat
	}
	if item.Username == "" {
		return LedgerItem{}, errors.New("missing username")
	}
	cfg, err := s.Config(ctx)
	if err != nil {
		return LedgerItem{}, err
	}
	if !cfg.Enabled {
		item.UserChargeUnits = 0
	} else if item.UserChargeUnits <= 0 {
		item.UserChargeUnits = calculateChargeUnits(cfg, item.TotalTokens, item.EstimatedTokens)
	}
	if item.Reason == "" {
		item.Reason = "ai_chat_success"
	}
	tag, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_billing_ledger (
			task_id, username, feature_key, model, provider_id,
			prompt_tokens, completion_tokens, total_tokens, estimated_tokens,
			upstream_request_id, upstream_quota_delta, upstream_cost_usd_micros,
			user_charge_units, status, reason, created_at, settled_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
		ON CONFLICT DO NOTHING`,
		strings.TrimSpace(item.TaskID), item.Username, item.FeatureKey, strings.TrimSpace(item.Model), item.ProviderID,
		item.PromptTokens, item.CompletionTokens, item.TotalTokens, item.EstimatedTokens,
		strings.TrimSpace(item.UpstreamRequestID), item.UpstreamQuotaDelta, item.UpstreamCostUSDMicro,
		item.UserChargeUnits, StatusSettled, strings.TrimSpace(item.Reason))
	if err != nil {
		return LedgerItem{}, err
	}
	if tag.RowsAffected() == 0 && strings.TrimSpace(item.TaskID) == "" {
		return LedgerItem{}, errors.New("AI billing ledger insert ignored")
	}
	return s.findLedger(ctx, item.TaskID, item.FeatureKey)
}

func calculateChargeUnits(cfg Config, totalTokens int, estimatedTokens int) int64 {
	tokens := totalTokens
	if tokens <= 0 {
		tokens = estimatedTokens
	}
	charge := int64(0)
	if tokens > 0 {
		charge = int64(math.Ceil((float64(tokens) / 1000) * cfg.UserUnitsPer1KTokens * cfg.DefaultMarkup))
	}
	if cfg.MinimumChargeUnits > 0 && charge < cfg.MinimumChargeUnits {
		charge = cfg.MinimumChargeUnits
	}
	return charge
}

func (s *Service) findLedger(ctx context.Context, taskID string, feature string) (LedgerItem, error) {
	var item LedgerItem
	err := s.db.QueryRow(ctx, `
		SELECT id, task_id, username, feature_key, model, provider_id,
		       prompt_tokens, completion_tokens, total_tokens, estimated_tokens,
		       upstream_request_id, upstream_quota_delta, upstream_cost_usd_micros,
		       user_charge_units, status, reason, created_at, settled_at
		FROM im_ai_billing_ledger
		WHERE task_id = $1 AND feature_key = $2
		ORDER BY id DESC
		LIMIT 1`, strings.TrimSpace(taskID), strings.TrimSpace(feature)).Scan(
		&item.ID, &item.TaskID, &item.Username, &item.FeatureKey, &item.Model, &item.ProviderID,
		&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens, &item.EstimatedTokens,
		&item.UpstreamRequestID, &item.UpstreamQuotaDelta, &item.UpstreamCostUSDMicro,
		&item.UserChargeUnits, &item.Status, &item.Reason, &item.CreatedAt, &item.SettledAt)
	return item, err
}

func (s *Service) LastCharge(ctx context.Context, username string) (*LedgerItem, error) {
	username = normalizeUsername(username)
	if s == nil || s.db == nil || username == "" {
		return nil, nil
	}
	var item LedgerItem
	err := s.db.QueryRow(ctx, `
		SELECT id, task_id, username, feature_key, model, provider_id,
		       prompt_tokens, completion_tokens, total_tokens, estimated_tokens,
		       upstream_request_id, upstream_quota_delta, upstream_cost_usd_micros,
		       user_charge_units, status, reason, created_at, settled_at
		FROM im_ai_billing_ledger
		WHERE username = $1 AND status = $2
		ORDER BY settled_at DESC, id DESC
		LIMIT 1`, username, StatusSettled).Scan(
		&item.ID, &item.TaskID, &item.Username, &item.FeatureKey, &item.Model, &item.ProviderID,
		&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens, &item.EstimatedTokens,
		&item.UpstreamRequestID, &item.UpstreamQuotaDelta, &item.UpstreamCostUSDMicro,
		&item.UserChargeUnits, &item.Status, &item.Reason, &item.CreatedAt, &item.SettledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *Service) Overview(ctx context.Context, limit int) (Overview, error) {
	cfg, err := s.Config(ctx)
	if err != nil {
		return Overview{}, err
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	dayStart, nextDay := currentDayRange()
	monthStart, nextMonth, _ := currentMonthRange()
	var overview Overview
	overview.Config = cfg
	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(user_charge_units), 0), COUNT(*)
		FROM im_ai_billing_ledger
		WHERE status = $1 AND created_at >= $2 AND created_at < $3`, StatusSettled, dayStart, nextDay).Scan(&overview.TodayUnits, &overview.TodayTasks)
	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(user_charge_units), 0), COUNT(*)
		FROM im_ai_billing_ledger
		WHERE status = $1 AND created_at >= $2 AND created_at < $3`, StatusSettled, monthStart, nextMonth).Scan(&overview.MonthUnits, &overview.MonthTasks)
	rows, err := s.db.Query(ctx, `
		SELECT id, task_id, username, feature_key, model, provider_id,
		       prompt_tokens, completion_tokens, total_tokens, estimated_tokens,
		       upstream_request_id, upstream_quota_delta, upstream_cost_usd_micros,
		       user_charge_units, status, reason, created_at, settled_at
		FROM im_ai_billing_ledger
		ORDER BY id DESC
		LIMIT $1`, limit)
	if err != nil {
		return Overview{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item LedgerItem
		if err := rows.Scan(
			&item.ID, &item.TaskID, &item.Username, &item.FeatureKey, &item.Model, &item.ProviderID,
			&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens, &item.EstimatedTokens,
			&item.UpstreamRequestID, &item.UpstreamQuotaDelta, &item.UpstreamCostUSDMicro,
			&item.UserChargeUnits, &item.Status, &item.Reason, &item.CreatedAt, &item.SettledAt); err != nil {
			return Overview{}, err
		}
		overview.RecentLedger = append(overview.RecentLedger, item)
	}
	return overview, rows.Err()
}

func currentDayRange() (time.Time, time.Time) {
	now := time.Now().In(beijingLocation)
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, beijingLocation)
	return start, start.Add(24 * time.Hour)
}

func currentMonthRange() (time.Time, time.Time, time.Time) {
	now := time.Now().In(beijingLocation)
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, beijingLocation)
	next := start.AddDate(0, 1, 0)
	return start, next, next
}

func normalizeTier(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "basic", "normal", "common":
		return "basic"
	case "advanced", "advance", "pro":
		return "advanced"
	case "honor":
		return "honor"
	case "supreme", "ultimate":
		return "supreme"
	default:
		return "trial"
	}
}

func normalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
