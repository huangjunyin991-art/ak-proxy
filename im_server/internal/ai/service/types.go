package service

import (
	"context"
	"time"

	"im_server/internal/ai/billing"
	"im_server/internal/entitlement"
)

type MessageRef struct {
	ID             int64
	ConversationID int64
	SenderUsername string
	Content        string
}

type MessageSink interface {
	InsertAITextMessage(ctx context.Context, conversationID int64, senderUsername string, content string) (MessageRef, error)
}

type Bootstrap struct {
	Enabled          bool                 `json:"enabled"`
	Available        bool                 `json:"available"`
	BotUsername      string               `json:"bot_username"`
	BotDisplayName   string               `json:"bot_display_name"`
	Entitlement      entitlement.Snapshot `json:"entitlement"`
	Billing          billing.Snapshot     `json:"billing"`
	ProviderReady    bool                 `json:"provider_ready"`
	ProviderMessage  string               `json:"provider_message,omitempty"`
	QueueConcurrency int                  `json:"queue_concurrency"`
}

type RuntimeConfig struct {
	Enabled                 bool `json:"enabled"`
	ContextSummaryMinCount  int  `json:"context_summary_min_count"`
	ContextRecentKeepCount  int  `json:"context_recent_keep_count"`
	ContextSummaryMinTokens int  `json:"context_summary_min_tokens"`
	ContextRecentKeepTokens int  `json:"context_recent_keep_tokens"`
	ContextScanMaxCount     int  `json:"context_scan_max_count"`
	ChatMaxOutputTokens     int  `json:"chat_max_output_tokens"`
	SummaryMaxOutputTokens  int  `json:"summary_max_output_tokens"`
	SummaryMemoryMaxTokens  int  `json:"summary_memory_max_tokens"`
}

type Task struct {
	TaskID         string     `json:"task_id"`
	ConversationID int64      `json:"conversation_id"`
	OwnerUsername  string     `json:"owner_username"`
	Status         string     `json:"status"`
	QueuePosition  int        `json:"queue_position"`
	Message        string     `json:"message"`
	CreatedAt      time.Time  `json:"created_at"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
}
