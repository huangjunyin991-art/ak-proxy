package service

import (
	"context"
	"time"

	"im_server/internal/ai/billing"
	messagetree "im_server/internal/ai/message_tree"
	aisession "im_server/internal/ai/session"
	"im_server/internal/entitlement"
)

type MessageRef struct {
	ID             int64
	ConversationID int64
	SenderUsername string
	Content        string
	Suggestions    []string
}

type MessageSink interface {
	InsertAITextMessage(ctx context.Context, conversationID int64, senderUsername string, content string) (MessageRef, error)
}

type SuggestionMessageSink interface {
	InsertAITextMessageWithSuggestions(ctx context.Context, conversationID int64, senderUsername string, content string, suggestions []string) (MessageRef, error)
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
	Enabled                  bool   `json:"enabled"`
	ContextSummaryMinCount   int    `json:"context_summary_min_count"`
	ContextRecentKeepCount   int    `json:"context_recent_keep_count"`
	ContextSummaryMinTokens  int    `json:"context_summary_min_tokens"`
	ContextRecentKeepTokens  int    `json:"context_recent_keep_tokens"`
	ContextScanMaxCount      int    `json:"context_scan_max_count"`
	ChatContextMaxMessages   int    `json:"chat_context_max_messages"`
	ChatContextMaxTokens     int    `json:"chat_context_max_tokens"`
	GroupMentionEnabled      bool   `json:"group_mention_enabled"`
	ChatMaxOutputTokens      int    `json:"chat_max_output_tokens"`
	SummaryMaxOutputTokens   int    `json:"summary_max_output_tokens"`
	SummaryMemoryMaxTokens   int    `json:"summary_memory_max_tokens"`
	QueueConcurrency         int    `json:"queue_concurrency"`
	ProviderLoadBalance      bool   `json:"provider_load_balance"`
	ProviderMaxAttempts      int    `json:"provider_max_attempts"`
	ProviderCooldownSeconds  int    `json:"provider_cooldown_seconds"`
	ReplySuggestionsEnabled  bool   `json:"reply_suggestions_enabled"`
	ReplySuggestionsMode     string `json:"reply_suggestions_mode"`
	ReplySuggestionsWhenBusy bool   `json:"reply_suggestions_when_busy"`
}

type SessionList struct {
	Items           []aisession.Session `json:"items"`
	ActiveSessionID int64               `json:"active_session_id"`
	ActiveSession   *aisession.Session  `json:"active_session,omitempty"`
}

type SessionCreateInput struct {
	Title string `json:"title"`
}

type SessionUpdateInput struct {
	Title  *string `json:"title,omitempty"`
	Status *string `json:"status,omitempty"`
	Pinned *bool   `json:"pinned,omitempty"`
}

type SessionMessages struct {
	Session         aisession.Session    `json:"session"`
	ActiveMessageID int64                `json:"active_message_id"`
	Items           []SessionMessageItem `json:"items"`
}

type SessionMessageItem struct {
	messagetree.Message
	VersionCount int              `json:"version_count"`
	Versions     []MessageVersion `json:"versions,omitempty"`
}

type MessageVersion struct {
	ID        int64     `json:"id"`
	VersionNo int       `json:"version_no"`
	CreatedAt time.Time `json:"created_at"`
}

type MessageEditInput struct {
	Content string `json:"content"`
}

type Task struct {
	TaskID         string     `json:"task_id"`
	ConversationID int64      `json:"conversation_id"`
	OwnerUsername  string     `json:"owner_username"`
	Status         string     `json:"status"`
	Stage          string     `json:"stage,omitempty"`
	StageText      string     `json:"stage_text,omitempty"`
	QueuePosition  int        `json:"queue_position"`
	Message        string     `json:"message"`
	Suggestions    []string   `json:"suggestions,omitempty"`
	ErrorCode      string     `json:"error_code,omitempty"`
	ErrorMessage   string     `json:"error_message,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
}
