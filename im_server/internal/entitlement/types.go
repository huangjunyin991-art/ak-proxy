package entitlement

import "time"

const (
	TierTrial    = "trial"
	TierBasic    = "basic"
	TierAdvanced = "advanced"
	TierHonor    = "honor"
	TierSupreme  = "supreme"

	FeatureAIChat = "ai_chat"
)

var tierNames = map[string]string{
	TierTrial:    "试用",
	TierBasic:    "普通",
	TierAdvanced: "进阶",
	TierHonor:    "荣耀",
	TierSupreme:  "至尊",
}

type TierConfig struct {
	Tier                string `json:"tier"`
	TierName            string `json:"tier_name"`
	DailyLimit          int    `json:"daily_limit"`
	MonthlyLimit        int    `json:"monthly_limit"`
	Priority            int    `json:"priority"`
	MemoryRetentionDays int    `json:"memory_retention_days"`
	Enabled             bool   `json:"enabled"`
}

type QuotaSnapshot struct {
	DailyLimit       int       `json:"daily_limit"`
	DailyUsed        int       `json:"daily_used"`
	DailyRemaining   int       `json:"daily_remaining"`
	MonthlyLimit     int       `json:"monthly_limit"`
	MonthlyUsed      int       `json:"monthly_used"`
	MonthlyRemaining int       `json:"monthly_remaining"`
	ResetAt          time.Time `json:"reset_at"`
}

type Snapshot struct {
	Enabled   bool          `json:"enabled"`
	Tier      string        `json:"tier"`
	TierName  string        `json:"tier_name"`
	IsTrial   bool          `json:"is_trial"`
	ExpiresAt *time.Time    `json:"expires_at,omitempty"`
	Priority  int           `json:"priority"`
	Quota     QuotaSnapshot `json:"quota"`
}

type RedeemResult struct {
	Snapshot Snapshot `json:"snapshot"`
	Message  string   `json:"message"`
}

type PrecheckResult struct {
	Allowed  bool     `json:"allowed"`
	Code     string   `json:"code,omitempty"`
	Message  string   `json:"message,omitempty"`
	Snapshot Snapshot `json:"snapshot"`
}
