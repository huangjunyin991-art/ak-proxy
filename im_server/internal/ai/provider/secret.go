package provider

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strings"
)

func deriveKey(secret string) []byte {
	sum := sha256.Sum256([]byte(strings.TrimSpace(secret)))
	return sum[:]
}

func encryptSecret(masterSecret string, plain string) (string, error) {
	plain = strings.TrimSpace(plain)
	if plain == "" {
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
	ciphertext := gcm.Seal(nil, nonce, []byte(plain), nil)
	payload := append(nonce, ciphertext...)
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
	nonce := payload[:gcm.NonceSize()]
	ciphertext := payload[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func fingerprintSecret(secret string) string {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(secret))
	short := strings.ToUpper(hex.EncodeToString(sum[:])[:10])
	tail := secret
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return "sk-****" + strings.ToUpper(tail) + "-" + short
}
