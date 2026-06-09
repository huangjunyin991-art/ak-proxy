package provider

import "time"

type Account struct {
	ID                     int64      `json:"id"`
	ProviderName           string     `json:"provider_name"`
	BaseURL                string     `json:"base_url"`
	SecretFingerprint      string     `json:"secret_fingerprint"`
	ChatModel              string     `json:"chat_model"`
	SummaryModel           string     `json:"summary_model"`
	EmbeddingModel         string     `json:"embedding_model"`
	AvailableModels        []string   `json:"available_models,omitempty"`
	BalanceSupported       bool       `json:"balance_supported"`
	BalanceEndpoint        string     `json:"balance_endpoint"`
	BalanceCacheTTLSeconds int        `json:"balance_cache_ttl_seconds"`
	LowBalanceThreshold    float64    `json:"low_balance_threshold"`
	Enabled                bool       `json:"enabled"`
	LastTestAt             *time.Time `json:"last_test_at,omitempty"`
	LastTestStatus         string     `json:"last_test_status"`
	LastUsedAt             *time.Time `json:"last_used_at,omitempty"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

type Balance struct {
	ProviderID          int64      `json:"provider_id"`
	BalanceAmount       float64    `json:"balance_amount"`
	BalanceCurrency     string     `json:"balance_currency"`
	RawUnit             string     `json:"raw_unit"`
	LowBalanceThreshold float64    `json:"low_balance_threshold"`
	LowBalance          bool       `json:"low_balance"`
	LastRefreshAt       *time.Time `json:"last_refresh_at,omitempty"`
	LastError           string     `json:"last_error"`
	UpdatedAt           *time.Time `json:"updated_at,omitempty"`
	Supported           bool       `json:"supported"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Messages        []Message
	Model           string
	MaxOutputTokens int
	Temperature     float64
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type ChatResponse struct {
	Content           string `json:"content"`
	Model             string `json:"model"`
	ProviderID        int64  `json:"provider_id"`
	UpstreamRequestID string `json:"upstream_request_id,omitempty"`
	FinishReason      string `json:"finish_reason,omitempty"`
	Usage             Usage  `json:"usage"`
}

type TestResult struct {
	OK        bool   `json:"ok"`
	Status    int    `json:"status"`
	Message   string `json:"message"`
	LatencyMS int64  `json:"latency_ms"`
	Probe     string `json:"probe"`
	Model     string `json:"model,omitempty"`
	Content   string `json:"content,omitempty"`
}
