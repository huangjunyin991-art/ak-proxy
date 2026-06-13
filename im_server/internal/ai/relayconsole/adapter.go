package relayconsole

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
)

type Session struct {
	CookieName   string `json:"cookie_name,omitempty"`
	CookieValue  string `json:"cookie_value,omitempty"`
	UserID       string `json:"user_id,omitempty"`
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	TokenType    string `json:"token_type,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
}

type UsageSummary struct {
	TokenName      string         `json:"token_name"`
	TotalGranted   float64        `json:"total_granted"`
	TotalUsed      float64        `json:"total_used"`
	TotalAvailable float64        `json:"total_available"`
	UnlimitedQuota bool           `json:"unlimited_quota"`
	Raw            map[string]any `json:"raw"`
}

type ProviderDefaults struct {
	BaseURL                string
	BalanceSupported       bool
	BalanceEndpoint        string
	BalanceCacheTTLSeconds int
	NameFallback           string
}

type Adapter interface {
	Key() string
	Label() string
	DefaultBaseURL() string
	ProviderDefaults(account Account) (ProviderDefaults, error)
	Login(ctx context.Context, client *http.Client, account Account, password string) (Session, error)
	FetchAccountUsage(ctx context.Context, client *http.Client, account Account, session Session) (AccountUsage, error)
	ListTokens(ctx context.Context, client *http.Client, account Account, session Session) ([]TokenInfo, error)
	FetchTokenKey(ctx context.Context, client *http.Client, account Account, session Session, tokenID string) (string, error)
	FetchTokenUsage(ctx context.Context, client *http.Client, account Account, session Session, tokenKey string) (UsageSummary, error)
	FetchModels(ctx context.Context, client *http.Client, account Account, tokenKey string) ([]string, error)
}

var adapters = map[string]Adapter{
	AdapterNewAPI: newAPIAdapter{},
	AdapterX5M5X:  x5m5xAdapter{},
}

func adapterByKey(key string) Adapter {
	key = strings.ToLower(strings.TrimSpace(key))
	if key == "" {
		key = AdapterNewAPI
	}
	if adapter, ok := adapters[key]; ok {
		return adapter
	}
	return nil
}

func adapterLabel(key string) string {
	if adapter := adapterByKey(key); adapter != nil {
		return adapter.Label()
	}
	return strings.TrimSpace(key)
}

func ProviderDefaultsForAccount(account Account) (ProviderDefaults, error) {
	adapter := adapterByKey(account.AdapterKey)
	if adapter == nil {
		return ProviderDefaults{}, errors.New("unsupported relay console adapter")
	}
	return adapter.ProviderDefaults(account)
}

type newAPIAdapter struct{}

func (newAPIAdapter) Key() string {
	return AdapterNewAPI
}

func (newAPIAdapter) Label() string {
	return "New API"
}

func (newAPIAdapter) DefaultBaseURL() string {
	return "https://www.dreamfield.top"
}

func (newAPIAdapter) ProviderDefaults(account Account) (ProviderDefaults, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return ProviderDefaults{}, err
	}
	return ProviderDefaults{
		BaseURL:                strings.TrimRight(baseURL, "/") + "/v1",
		BalanceSupported:       true,
		BalanceEndpoint:        strings.TrimRight(baseURL, "/") + "/api/usage/token/",
		BalanceCacheTTLSeconds: 600,
		NameFallback:           "New API Relay",
	}, nil
}

func (newAPIAdapter) Login(ctx context.Context, client *http.Client, account Account, password string) (Session, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return Session{}, err
	}
	jar, _ := cookiejar.New(nil)
	loginClient := *client
	loginClient.Jar = jar
	payload, _ := json.Marshal(map[string]string{
		"username": strings.TrimSpace(account.Username),
		"password": password,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/user/login", bytes.NewReader(payload))
	if err != nil {
		return Session{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := loginClient.Do(req)
	if err != nil {
		return Session{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return Session{}, err
	}
	var parsed struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			ID         any    `json:"id"`
			Require2FA bool   `json:"require_2fa"`
			Username   string `json:"username"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Session{}, err
	}
	if !parsed.Success {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("New API login failed status=%d", resp.StatusCode)
		}
		return Session{}, errors.New(parsed.Message)
	}
	if parsed.Data.Require2FA {
		return Session{}, errors.New("New API account requires 2FA; please use a service account without 2FA")
	}
	parsedURL, _ := url.Parse(baseURL)
	sessionValue := ""
	for _, cookie := range jar.Cookies(parsedURL) {
		if cookie.Name == "session" {
			sessionValue = cookie.Value
			break
		}
	}
	if sessionValue == "" {
		return Session{}, errors.New("New API login did not return session cookie")
	}
	userID := stringify(parsed.Data.ID)
	if userID == "" {
		return Session{}, errors.New("New API login did not return user id")
	}
	return Session{CookieName: "session", CookieValue: sessionValue, UserID: userID}, nil
}

func (newAPIAdapter) FetchAccountUsage(ctx context.Context, client *http.Client, account Account, session Session) (AccountUsage, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return AccountUsage{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/user/self", nil)
	if err != nil {
		return AccountUsage{}, err
	}
	attachNewAPIConsoleAuth(req, account, session)
	resp, err := client.Do(req)
	if err != nil {
		return AccountUsage{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return AccountUsage{}, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return AccountUsage{}, fmt.Errorf("New API self unauthorized status=%d", resp.StatusCode)
	}
	var parsed struct {
		Success bool           `json:"success"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return AccountUsage{}, err
	}
	if !parsed.Success {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("New API self status=%d", resp.StatusCode)
		}
		return AccountUsage{}, errors.New(parsed.Message)
	}
	if parsed.Data == nil {
		parsed.Data = map[string]any{}
	}
	quota := float64Field(parsed.Data, "quota")
	usedQuota := float64Field(parsed.Data, "used_quota")
	userID := stringify(parsed.Data["id"])
	if userID == "" {
		userID = strings.TrimSpace(account.UserID)
	}
	return AccountUsage{
		Username:     stringField(parsed.Data, "username"),
		UserID:       userID,
		Quota:        quota,
		UsedQuota:    usedQuota,
		TotalQuota:   quota + usedQuota,
		RequestCount: float64Field(parsed.Data, "request_count"),
		LowBalance:   account.LowBalanceQuota > 0 && quota <= account.LowBalanceQuota,
		Source:       "api/user/self",
	}, nil
}

func (newAPIAdapter) ListTokens(ctx context.Context, client *http.Client, account Account, session Session) ([]TokenInfo, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/token/?p=1&size=100", nil)
	if err != nil {
		return nil, err
	}
	attachNewAPIConsoleAuth(req, account, session)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("New API token list unauthorized status=%d", resp.StatusCode)
	}
	var parsed struct {
		Success bool            `json:"success"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !parsed.Success {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("New API token list status=%d", resp.StatusCode)
		}
		return nil, errors.New(parsed.Message)
	}
	return parseNewAPITokens(parsed.Data), nil
}

func (newAPIAdapter) FetchTokenKey(ctx context.Context, client *http.Client, account Account, session Session, tokenID string) (string, error) {
	tokenID = strings.TrimSpace(tokenID)
	if tokenID == "" {
		return "", errors.New("missing token_id")
	}
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/token/"+url.PathEscape(tokenID)+"/key", nil)
	if err != nil {
		return "", err
	}
	attachNewAPIConsoleAuth(req, account, session)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return "", err
	}
	var parsed struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			Key string `json:"key"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	if !parsed.Success {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("New API token key status=%d", resp.StatusCode)
		}
		return "", errors.New(parsed.Message)
	}
	key := strings.TrimSpace(parsed.Data.Key)
	if key == "" {
		return "", errors.New("New API returned empty token key")
	}
	return key, nil
}

func (newAPIAdapter) FetchTokenUsage(ctx context.Context, client *http.Client, account Account, session Session, tokenKey string) (UsageSummary, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return UsageSummary{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/usage/token/", nil)
	if err != nil {
		return UsageSummary{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(tokenKey))
	resp, err := client.Do(req)
	if err != nil {
		return UsageSummary{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return UsageSummary{}, err
	}
	var parsed struct {
		Code    bool           `json:"code"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return UsageSummary{}, err
	}
	if !parsed.Code {
		if parsed.Message == "" {
			parsed.Message = fmt.Sprintf("New API usage status=%d", resp.StatusCode)
		}
		return UsageSummary{}, errors.New(parsed.Message)
	}
	if parsed.Data == nil {
		parsed.Data = map[string]any{}
	}
	return UsageSummary{
		TokenName:      stringField(parsed.Data, "name"),
		TotalGranted:   float64Field(parsed.Data, "total_granted"),
		TotalUsed:      float64Field(parsed.Data, "total_used"),
		TotalAvailable: float64Field(parsed.Data, "total_available"),
		UnlimitedQuota: boolField(parsed.Data, "unlimited_quota"),
		Raw:            parsed.Data,
	}, nil
}

func (newAPIAdapter) FetchModels(ctx context.Context, client *http.Client, account Account, tokenKey string) ([]string, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterNewAPI)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(tokenKey))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("New API models status=%d", resp.StatusCode)
	}
	models := parseNewAPIModels(body)
	if len(models) == 0 {
		return nil, errors.New("New API returned empty model list")
	}
	return models, nil
}

func attachNewAPIConsoleAuth(req *http.Request, account Account, session Session) {
	req.Header.Set("Accept", "application/json")
	userID := strings.TrimSpace(session.UserID)
	if userID == "" {
		userID = strings.TrimSpace(account.UserID)
	}
	if userID != "" {
		req.Header.Set("New-Api-User", userID)
	}
	cookieName := strings.TrimSpace(session.CookieName)
	if cookieName == "" {
		cookieName = "session"
	}
	if strings.TrimSpace(session.CookieValue) != "" {
		req.AddCookie(&http.Cookie{Name: cookieName, Value: session.CookieValue, Path: "/"})
	}
}
