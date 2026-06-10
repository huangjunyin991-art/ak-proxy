package relayconsole

import "time"

const (
	AdapterNewAPI = "newapi"
)

type Account struct {
	ID              int64      `json:"id"`
	AdapterKey      string     `json:"adapter_key"`
	AdapterLabel    string     `json:"adapter_label"`
	DisplayName     string     `json:"display_name"`
	ConsoleBaseURL  string     `json:"console_base_url"`
	Username        string     `json:"username"`
	UserID          string     `json:"user_id"`
	HasPassword     bool       `json:"has_password"`
	HasSession      bool       `json:"has_session"`
	Enabled         bool       `json:"enabled"`
	LowBalanceQuota float64    `json:"low_balance_quota"`
	LastLoginAt     *time.Time `json:"last_login_at,omitempty"`
	LastSyncAt      *time.Time `json:"last_sync_at,omitempty"`
	LastError       string     `json:"last_error"`
	UpdatedAt       *time.Time `json:"updated_at,omitempty"`
}

type CredentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type TokenInfo struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Status             int     `json:"status"`
	Group              string  `json:"group"`
	KeyMasked          string  `json:"key_masked"`
	RemainQuota        float64 `json:"remain_quota"`
	UsedQuota          float64 `json:"used_quota"`
	UnlimitedQuota     bool    `json:"unlimited_quota"`
	ModelLimitsEnabled bool    `json:"model_limits_enabled"`
	ExpiredTime        int64   `json:"expired_time"`
}

type AccountUsage struct {
	ConsoleID    int64   `json:"console_id"`
	Username     string  `json:"username"`
	UserID       string  `json:"user_id"`
	Quota        float64 `json:"quota"`
	UsedQuota    float64 `json:"used_quota"`
	TotalQuota   float64 `json:"total_quota"`
	RequestCount float64 `json:"request_count"`
	LowBalance   bool    `json:"low_balance"`
	Source       string  `json:"source"`
}

type TokenList struct {
	ConsoleID    int64         `json:"console_id"`
	Tokens       []TokenInfo   `json:"tokens"`
	AccountUsage *AccountUsage `json:"account_usage,omitempty"`
}

type ModelList struct {
	ConsoleID int64    `json:"console_id"`
	TokenID   string   `json:"token_id"`
	Models    []string `json:"models"`
}

type BalanceSnapshot struct {
	ID             int64     `json:"id"`
	ConsoleID      int64     `json:"console_id"`
	AdapterKey     string    `json:"adapter_key"`
	DisplayName    string    `json:"display_name"`
	Username       string    `json:"username"`
	UserID         string    `json:"user_id"`
	TokenRef       string    `json:"token_ref"`
	TokenName      string    `json:"token_name"`
	TotalGranted   float64   `json:"total_granted"`
	TotalUsed      float64   `json:"total_used"`
	TotalAvailable float64   `json:"total_available"`
	UnlimitedQuota bool      `json:"unlimited_quota"`
	LowBalance     bool      `json:"low_balance"`
	SyncedAt       time.Time `json:"synced_at"`
}

type Status struct {
	Accounts       []Account                 `json:"accounts"`
	LatestBalance  *BalanceSnapshot          `json:"latest_balance,omitempty"`
	LatestBalances map[int64]BalanceSnapshot `json:"latest_balances,omitempty"`
}

type ImportProviderRequest struct {
	ConsoleID  int64  `json:"console_id"`
	TokenID    string `json:"token_id"`
	ProviderID int64  `json:"provider_id"`
}
