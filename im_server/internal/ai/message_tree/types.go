package messagetree

import "time"

const (
	RoleSystem    = "system"
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
)

type Message struct {
	ID                  int64          `json:"id"`
	SessionID           int64          `json:"session_id"`
	ParentID            int64          `json:"parent_id,omitempty"`
	Role                string         `json:"role"`
	Content             string         `json:"content"`
	VersionGroupID      string         `json:"version_group_id"`
	VersionNo           int            `json:"version_no"`
	SourceMessageID     int64          `json:"source_message_id,omitempty"`
	ProjectionMessageID int64          `json:"projection_message_id,omitempty"`
	ProviderID          int64          `json:"provider_id,omitempty"`
	Model               string         `json:"model,omitempty"`
	FinishReason        string         `json:"finish_reason,omitempty"`
	PromptTokens        int            `json:"prompt_tokens,omitempty"`
	CompletionTokens    int            `json:"completion_tokens,omitempty"`
	TotalTokens         int            `json:"total_tokens,omitempty"`
	Metadata            map[string]any `json:"metadata,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
	UpdatedAt           time.Time      `json:"updated_at"`
}

type AppendInput struct {
	SessionID           int64          `json:"session_id"`
	ParentID            int64          `json:"parent_id,omitempty"`
	Role                string         `json:"role"`
	Content             string         `json:"content"`
	VersionGroupID      string         `json:"version_group_id,omitempty"`
	VersionNo           int            `json:"version_no,omitempty"`
	SourceMessageID     int64          `json:"source_message_id,omitempty"`
	ProjectionMessageID int64          `json:"projection_message_id,omitempty"`
	ProviderID          int64          `json:"provider_id,omitempty"`
	Model               string         `json:"model,omitempty"`
	FinishReason        string         `json:"finish_reason,omitempty"`
	PromptTokens        int            `json:"prompt_tokens,omitempty"`
	CompletionTokens    int            `json:"completion_tokens,omitempty"`
	TotalTokens         int            `json:"total_tokens,omitempty"`
	Metadata            map[string]any `json:"metadata,omitempty"`
}

type ProjectionInput struct {
	AIMessageID    int64 `json:"ai_message_id"`
	ConversationID int64 `json:"conversation_id"`
	MessageID      int64 `json:"message_id"`
	Visible        bool  `json:"visible"`
}
