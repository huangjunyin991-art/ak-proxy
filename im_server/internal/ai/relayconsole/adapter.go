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
	CookieName  string `json:"cookie_name"`
	CookieValue string `json:"cookie_value"`
	UserID      string `json:"user_id"`
}

type UsageSummary struct {
	TokenName      string         `json:"token_name"`
	TotalGranted   float64        `json:"total_granted"`
	TotalUsed      float64        `json:"total_used"`
	TotalAvailable float64        `json:"total_available"`
	UnlimitedQuota bool           `json:"unlimited_quota"`
	Raw            map[string]any `json:"raw"`
}

type Adapter interface {
	Key() string
	Label() string
	DefaultBaseURL() string
	Login(ctx context.Context, client *http.Client, account Account, password string) (Session, error)
	ListTokens(ctx context.Context, client *http.Client, account Account, session Session) ([]TokenInfo, error)
	FetchTokenKey(ctx context.Context, client *http.Client, account Account, session Session, tokenID string) (string, error)
	FetchTokenUsage(ctx context.Context, client *http.Client, account Account, tokenKey string) (UsageSummary, error)
}

var adapters = map[string]Adapter{
	AdapterNewAPI: newAPIAdapter{},
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

func (newAPIAdapter) FetchTokenUsage(ctx context.Context, client *http.Client, account Account, tokenKey string) (UsageSummary, error) {
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
