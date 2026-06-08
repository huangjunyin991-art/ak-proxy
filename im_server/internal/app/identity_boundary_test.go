package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"im_server/internal/config"
)

func TestValidateIdentityBoundaryConfigRequiresSecretByDefault(t *testing.T) {
	err := validateIdentityBoundaryConfig(config.Config{})
	if err == nil || !strings.Contains(err.Error(), "missing signed identity secret") {
		t.Fatalf("expected missing signed identity secret, got %v", err)
	}
}

func TestValidateIdentityBoundaryConfigAllowsSignedSecret(t *testing.T) {
	err := validateIdentityBoundaryConfig(config.Config{NotifyCenterIdentitySecret: "identity-secret"})
	if err != nil {
		t.Fatalf("expected signed identity secret to pass, got %v", err)
	}
}

func TestValidateIdentityBoundaryConfigAllowsExplicitUnsignedDevMode(t *testing.T) {
	err := validateIdentityBoundaryConfig(config.Config{AllowUnsignedIdentity: true})
	if err != nil {
		t.Fatalf("expected explicit unsigned dev mode to pass, got %v", err)
	}
}

func TestResolveUsernameRequiresSignedIdentityByDefault(t *testing.T) {
	app := &App{cfg: config.Config{CookieName: "ak_username"}}
	req := httptest.NewRequest("GET", "/im/api/bootstrap", nil)
	req.AddCookie(buildTestCookie("ak_username", "alice"))

	username, err := app.resolveUsername(req)
	if err == nil || !strings.Contains(err.Error(), "missing signed identity configuration") {
		t.Fatalf("expected missing signed identity configuration, got username=%q err=%v", username, err)
	}
}

func TestResolveUsernameAllowsUnsignedOnlyWhenExplicitlyEnabled(t *testing.T) {
	app := &App{cfg: config.Config{CookieName: "ak_username", AllowUnsignedIdentity: true}}
	req := httptest.NewRequest("GET", "/im/api/bootstrap", nil)
	req.AddCookie(buildTestCookie("ak_username", "Alice"))

	username, err := app.resolveUsername(req)
	if err != nil {
		t.Fatalf("expected unsigned identity fallback, got err=%v", err)
	}
	if username != "alice" {
		t.Fatalf("expected normalized cookie username, got %q", username)
	}
}

func TestResolveUsernameRejectsMissingSignedCookieWhenSecretExists(t *testing.T) {
	app := &App{cfg: config.Config{
		CookieName:                 "ak_username",
		NotifyCenterIdentitySecret: "identity-secret",
		NotifyCenterIdentityCookie: "ak_notify_identity",
	}}
	req := httptest.NewRequest("GET", "/im/api/bootstrap", nil)
	req.AddCookie(buildTestCookie("ak_username", "alice"))

	username, err := app.resolveUsername(req)
	if err == nil || !strings.Contains(err.Error(), "missing signed identity") {
		t.Fatalf("expected missing signed identity, got username=%q err=%v", username, err)
	}
}

func TestResolveUsernamePrefersSignedIdentityOverPlainCookie(t *testing.T) {
	secret := "identity-secret"
	app := &App{cfg: config.Config{
		CookieName:                 "ak_username",
		NotifyCenterIdentitySecret: secret,
		NotifyCenterIdentityCookie: "ak_notify_identity",
	}}
	req := httptest.NewRequest("GET", "/im/api/bootstrap", nil)
	req.AddCookie(buildTestCookie("ak_username", "attacker"))
	req.AddCookie(buildTestCookie("ak_notify_identity", buildSignedIdentityCookie("Alice", secret, time.Now().Add(time.Hour))))

	username, err := app.resolveUsername(req)
	if err != nil {
		t.Fatalf("expected signed identity, got err=%v", err)
	}
	if username != "alice" {
		t.Fatalf("expected signed username alice, got %q", username)
	}
}

func TestResolveUsernameDevFallbackWithSecretRequiresExplicitFlag(t *testing.T) {
	app := &App{cfg: config.Config{
		CookieName:                 "ak_username",
		NotifyCenterIdentitySecret: "identity-secret",
		AllowUnsignedIdentity:      true,
	}}
	req := httptest.NewRequest("GET", "/im/api/bootstrap", nil)
	req.AddCookie(buildTestCookie("ak_im_username", "Bob"))

	username, err := app.resolveUsername(req)
	if err != nil {
		t.Fatalf("expected explicit dev fallback, got err=%v", err)
	}
	if username != "bob" {
		t.Fatalf("expected fallback username bob, got %q", username)
	}
}

func buildTestCookie(name string, value string) *http.Cookie {
	return &http.Cookie{Name: name, Value: value, Path: "/"}
}

func buildSignedIdentityCookie(subject string, secret string, expires time.Time) string {
	payload, _ := json.Marshal(map[string]any{
		"sub": subject,
		"exp": expires.Unix(),
	})
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signed := "v1." + encoded
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	return signed + "." + hex.EncodeToString(mac.Sum(nil))
}
