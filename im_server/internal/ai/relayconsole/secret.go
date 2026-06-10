package relayconsole

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

func deriveKey(secret string) []byte {
	sum := sha256.Sum256([]byte(strings.TrimSpace(secret)))
	return sum[:]
}

func encryptSecret(masterSecret string, plain string) (string, error) {
	if strings.TrimSpace(plain) == "" {
		return "", errors.New("empty secret")
	}
	if strings.TrimSpace(masterSecret) == "" {
		return "", errors.New("missing IM_AI_SECRET_KEY")
	}
	block, err := aes.NewCipher(deriveKey(masterSecret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	payload := append(nonce, gcm.Seal(nil, nonce, []byte(plain), nil)...)
	return "v1:" + base64.StdEncoding.EncodeToString(payload), nil
}

func decryptSecret(masterSecret string, encoded string) (string, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return "", errors.New("secret not configured")
	}
	if strings.TrimSpace(masterSecret) == "" {
		return "", errors.New("missing IM_AI_SECRET_KEY")
	}
	if !strings.HasPrefix(encoded, "v1:") {
		return "", errors.New("unsupported secret format")
	}
	payload, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, "v1:"))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(deriveKey(masterSecret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", errors.New("invalid secret payload")
	}
	returnBytes, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(returnBytes), nil
}
