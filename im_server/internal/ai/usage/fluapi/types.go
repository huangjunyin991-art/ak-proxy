package fluapi

import "time"

type Config struct {
	Enabled       bool       `json:"enabled"`
	BaseURL       string     `json:"base_url"`
	Username      string     `json:"username"`
	UserID        string     `json:"user_id"`
	HasPassword   bool       `json:"has_password"`
	HasSession    bool       `json:"has_session"`
	QuotaPerUSD   int64      `json:"quota_per_usd"`
	LowBalanceUSD float64    `json:"low_balance_usd"`
	LastLoginAt   *time.Time `json:"last_login_at,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	LastError     string     `json:"last_error"`
	UpdatedAt     *time.Time `json:"updated_at,omitempty"`
}

type CredentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type BalanceSnapshot struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	UserID       string    `json:"user_id"`
	Quota        int64     `json:"quota"`
	UsedQuota    int64     `json:"used_quota"`
	RequestCount int64     `json:"request_count"`
	BalanceUSD   float64   `json:"balance_usd"`
	UsedUSD      float64   `json:"used_usd"`
	TotalUSD     float64   `json:"total_usd"`
	LowBalance   bool      `json:"low_balance"`
	SyncedAt     time.Time `json:"synced_at"`
}

type Status struct {
	Config        Config           `json:"config"`
	LatestBalance *BalanceSnapshot `json:"latest_balance,omitempty"`
}
