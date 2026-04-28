package social

const (
	ContactSourceManual    = "manual"
	ContactSourceWhitelist = "whitelist"

	SendRestrictionNone          = ""
	SendRestrictionBlocked       = "blocked"
	SendRestrictionAwaitingReply = "awaiting_reply"
)

type IdentityItem struct {
	Username    string
	DisplayName string
	HonorName   string
	AvatarURL   string
}

type ContactItem struct {
	Username             string `json:"username"`
	DisplayName          string `json:"display_name"`
	HonorName            string `json:"honor_name,omitempty"`
	AvatarURL            string `json:"avatar_url,omitempty"`
	Source               string `json:"source,omitempty"`
	IsContact            bool   `json:"is_contact,omitempty"`
	IsBlacklisted        bool   `json:"is_blacklisted,omitempty"`
	ActionDisabledReason string `json:"action_disabled_reason,omitempty"`
}

type ContactSection struct {
	Key   string        `json:"key"`
	Title string        `json:"title"`
	Items []ContactItem `json:"items"`
}

type ContactsResult struct {
	Items    []ContactItem    `json:"items"`
	Sections []ContactSection `json:"sections,omitempty"`
}

type DirectSendRule struct {
	ConversationID      int64  `json:"conversation_id,omitempty"`
	PeerUsername        string `json:"peer_username,omitempty"`
	CanSend             bool   `json:"can_send"`
	SendRestriction     string `json:"send_restriction,omitempty"`
	SendRestrictionHint string `json:"send_restriction_hint,omitempty"`
	AwaitingPeerReply   bool   `json:"awaiting_peer_reply,omitempty"`
	SelfBlacklistedPeer bool   `json:"self_blacklisted_peer,omitempty"`
	BlockedByPeer       bool   `json:"blocked_by_peer,omitempty"`
}

type SendRestrictedError struct {
	Rule DirectSendRule
}

func (e *SendRestrictedError) Error() string {
	if e == nil {
		return "当前会话暂不可发送消息"
	}
	if hint := e.Rule.SendRestrictionHint; hint != "" {
		return hint
	}
	if e.Rule.SendRestriction == SendRestrictionBlocked {
		return "当前会话暂不可发送消息"
	}
	if e.Rule.SendRestriction == SendRestrictionAwaitingReply {
		return "对方回复前你只能发送一条消息"
	}
	return "当前会话暂不可发送消息"
}
