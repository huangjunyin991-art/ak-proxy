package session

import "time"

const (
	StatusActive   = "active"
	StatusArchived = "archived"
	StatusDeleted  = "deleted"
)

type Session struct {
	ID              int64          `json:"id"`
	OwnerUsername   string         `json:"owner_username"`
	ConversationID  int64          `json:"conversation_id,omitempty"`
	Title           string         `json:"title"`
	Status          string         `json:"status"`
	Pinned          bool           `json:"pinned"`
	ActiveMessageID int64          `json:"active_message_id,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type CreateInput struct {
	OwnerUsername  string         `json:"owner_username"`
	ConversationID int64          `json:"conversation_id,omitempty"`
	Title          string         `json:"title"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

type UpdateInput struct {
	ID              int64          `json:"id"`
	OwnerUsername   string         `json:"owner_username"`
	Title           *string        `json:"title,omitempty"`
	Status          *string        `json:"status,omitempty"`
	Pinned          *bool          `json:"pinned,omitempty"`
	ActiveMessageID *int64         `json:"active_message_id,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}
