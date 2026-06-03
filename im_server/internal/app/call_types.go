package app

import "time"

const imCallTimeoutSeconds = 30
const imCallActiveTimeoutSeconds = 45

type IMCallStatus string

const (
	IMCallStatusDialing  IMCallStatus = "dialing"
	IMCallStatusRinging  IMCallStatus = "ringing"
	IMCallStatusActive   IMCallStatus = "active"
	IMCallStatusEnded    IMCallStatus = "ended"
	IMCallStatusFailed   IMCallStatus = "failed"
	IMCallStatusBusy     IMCallStatus = "busy"
	IMCallStatusTimeout  IMCallStatus = "timeout"
)

type imCallSession struct {
	CallID         string          `json:"call_id"`
	ConversationID int64           `json:"conversation_id"`
	CallerUsername string          `json:"caller_username"`
	CalleeUsername string          `json:"callee_username"`
	CallKind       string          `json:"call_kind"`
	Status         IMCallStatus    `json:"status"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
	RingingAt      time.Time       `json:"ringing_at"`
	AcceptedAt     time.Time       `json:"accepted_at"`
	ConnectedAt    time.Time       `json:"connected_at"`
	EndedAt        time.Time       `json:"ended_at"`
	CallerMuted    bool            `json:"caller_muted"`
	CalleeMuted    bool            `json:"callee_muted"`
	CallerWSID     string          `json:"caller_ws_id"`
	CalleeWSID     string          `json:"callee_ws_id"`
	CallerPageID   string          `json:"caller_page_id"`
	CalleePageID   string          `json:"callee_page_id"`
	Metadata       map[string]any  `json:"metadata,omitempty"`
}

func (s *imCallSession) touch() {
	if s == nil {
		return
	}
	s.UpdatedAt = time.Now()
}

func (s *imCallSession) toMap() map[string]any {
	if s == nil {
		return map[string]any{}
	}
	return map[string]any{
		"call_id": s.CallID,
		"conversation_id": s.ConversationID,
		"caller_username": s.CallerUsername,
		"callee_username": s.CalleeUsername,
		"call_kind": s.CallKind,
		"status": string(s.Status),
		"created_at": s.CreatedAt.Format(time.RFC3339),
		"updated_at": s.UpdatedAt.Format(time.RFC3339),
		"ringing_at": zeroTimeToString(s.RingingAt),
		"accepted_at": zeroTimeToString(s.AcceptedAt),
		"connected_at": zeroTimeToString(s.ConnectedAt),
		"ended_at": zeroTimeToString(s.EndedAt),
		"caller_muted": s.CallerMuted,
		"callee_muted": s.CalleeMuted,
		"metadata": s.Metadata,
	}
}

func zeroTimeToString(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.Format(time.RFC3339)
}
