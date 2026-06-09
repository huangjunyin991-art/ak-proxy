package billing

import "time"

const (
	StatusSettled = "settled"
	FeatureAIChat = "ai_chat"
)

type Config struct {
	Enabled                bool             `json:"enabled"`
	UnitLabel              string           `json:"unit_label"`
	UserUnitsPer1KTokens   float64          `json:"user_units_per_1k_tokens"`
	DefaultMarkup          float64          `json:"default_markup"`
	MinimumChargeUnits     int64            `json:"minimum_charge_units"`
	TierMonthlyCreditUnits map[string]int64 `json:"tier_monthly_credit_units"`
}

type Snapshot struct {
	Enabled               bool        `json:"enabled"`
	UnitLabel             string      `json:"unit_label"`
	Tier                  string      `json:"tier"`
	MonthlyLimitUnits     int64       `json:"monthly_limit_units"`
	MonthlyUsedUnits      int64       `json:"monthly_used_units"`
	MonthlyRemainingUnits int64       `json:"monthly_remaining_units"`
	ResetAt               time.Time   `json:"reset_at"`
	LastCharge            *LedgerItem `json:"last_charge,omitempty"`
}

type PrecheckResult struct {
	Allowed  bool     `json:"allowed"`
	Code     string   `json:"code,omitempty"`
	Message  string   `json:"message,omitempty"`
	Snapshot Snapshot `json:"snapshot"`
}

type Settlement struct {
	TaskID               string
	Username             string
	FeatureKey           string
	Model                string
	ProviderID           int64
	PromptTokens         int
	CompletionTokens     int
	TotalTokens          int
	EstimatedTokens      int
	UpstreamRequestID    string
	UpstreamQuotaDelta   int64
	UpstreamCostUSDMicro int64
	UserChargeUnits      int64
	Reason               string
}

type LedgerItem struct {
	ID                   int64     `json:"id"`
	TaskID               string    `json:"task_id"`
	Username             string    `json:"username"`
	FeatureKey           string    `json:"feature_key"`
	Model                string    `json:"model"`
	ProviderID           int64     `json:"provider_id"`
	PromptTokens         int       `json:"prompt_tokens"`
	CompletionTokens     int       `json:"completion_tokens"`
	TotalTokens          int       `json:"total_tokens"`
	EstimatedTokens      int       `json:"estimated_tokens"`
	UpstreamRequestID    string    `json:"upstream_request_id,omitempty"`
	UpstreamQuotaDelta   int64     `json:"upstream_quota_delta"`
	UpstreamCostUSDMicro int64     `json:"upstream_cost_usd_micros"`
	UserChargeUnits      int64     `json:"user_charge_units"`
	Status               string    `json:"status"`
	Reason               string    `json:"reason"`
	CreatedAt            time.Time `json:"created_at"`
	SettledAt            time.Time `json:"settled_at"`
}

type Overview struct {
	Config       Config       `json:"config"`
	TodayUnits   int64        `json:"today_units"`
	MonthUnits   int64        `json:"month_units"`
	TodayTasks   int64        `json:"today_tasks"`
	MonthTasks   int64        `json:"month_tasks"`
	RecentLedger []LedgerItem `json:"recent_ledger"`
}
