package ws_ticket

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

type identityPayload struct {
	Subject string `json:"sub"`
	Expires int64  `json:"exp"`
}

func VerifyIdentityCookie(value string, secret string, now time.Time) string {
	token := strings.TrimSpace(value)
	normalizedSecret := strings.TrimSpace(secret)
	if token == "" || normalizedSecret == "" {
		return ""
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return ""
	}
	signed := parts[0] + "." + parts[1]
	expected := sign(signed, normalizedSecret)
	if !hmac.Equal([]byte(expected), []byte(strings.ToLower(strings.TrimSpace(parts[2])))) {
		return ""
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var payload identityPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return ""
	}
	if payload.Expires <= now.Unix() {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(payload.Subject))
}

func sign(value string, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}
