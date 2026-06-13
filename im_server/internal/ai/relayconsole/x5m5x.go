package relayconsole

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type x5m5xAdapter struct{}

func (x5m5xAdapter) Key() string {
	return AdapterX5M5X
}

func (x5m5xAdapter) Label() string {
	return "极速 API Gateway"
}

func (x5m5xAdapter) DefaultBaseURL() string {
	return "https://api.x5m5x.com"
}

func (x5m5xAdapter) ProviderDefaults(account Account) (ProviderDefaults, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
	if err != nil {
		return ProviderDefaults{}, err
	}
	return ProviderDefaults{
		BaseURL:                strings.TrimRight(baseURL, "/") + "/v1",
		BalanceSupported:       false,
		BalanceEndpoint:        "",
		BalanceCacheTTLSeconds: 600,
		NameFallback:           "极速 API Gateway",
	}, nil
}

func (x5m5xAdapter) Login(ctx context.Context, client *http.Client, account Account, password string) (Session, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
	if err != nil {
		return Session{}, err
	}
	payload, _ := json.Marshal(map[string]string{
		"email":    strings.TrimSpace(account.Username),
		"password": password,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/auth/login", bytes.NewReader(payload))
	if err != nil {
		return Session{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return Session{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return Session{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Session{}, fmt.Errorf("极速登录失败 status=%d: %s", resp.StatusCode, truncateRelayText(string(body), 180))
	}
	var parsed struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			TokenType    string `json:"token_type"`
			ExpiresIn    int64  `json:"expires_in"`
			User         struct {
				ID any `json:"id"`
			} `json:"user"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Session{}, err
	}
	if !x5m5xOK(parsed.Code) {
		if parsed.Message == "" {
			parsed.Message = "极速登录失败"
		}
		return Session{}, errors.New(parsed.Message)
	}
	accessToken := strings.TrimSpace(parsed.Data.AccessToken)
	if accessToken == "" {
		return Session{}, errors.New("极速登录没有返回 access_token")
	}
	tokenType := strings.TrimSpace(parsed.Data.TokenType)
	if tokenType == "" {
		tokenType = "Bearer"
	}
	expiresAt := int64(0)
	if parsed.Data.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(parsed.Data.ExpiresIn) * time.Second).Unix()
	}
	userID := stringify(parsed.Data.User.ID)
	if userID == "" {
		return Session{}, errors.New("极速登录没有返回 user id")
	}
	return Session{
		UserID:       userID,
		AccessToken:  accessToken,
		RefreshToken: strings.TrimSpace(parsed.Data.RefreshToken),
		TokenType:    tokenType,
		ExpiresAt:    expiresAt,
	}, nil
}

func (x5m5xAdapter) FetchAccountUsage(ctx context.Context, client *http.Client, account Account, session Session) (AccountUsage, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
	if err != nil {
		return AccountUsage{}, err
	}
	body, err := x5m5xRequest(ctx, client, session, http.MethodGet, baseURL+"/api/v1/user/profile", nil)
	if err != nil {
		return AccountUsage{}, err
	}
	data, err := x5m5xDataObject(body, "极速账户信息")
	if err != nil {
		return AccountUsage{}, err
	}
	quota := firstFloat64Field(data, "balance", "quota", "available", "remaining", "credit", "credits")
	usedQuota := firstFloat64Field(data, "used_quota", "used", "total_used", "usage")
	totalQuota := firstFloat64Field(data, "total_quota", "total", "total_granted")
	if totalQuota <= 0 {
		totalQuota = quota + usedQuota
	}
	userID := stringify(data["id"])
	if userID == "" {
		userID = strings.TrimSpace(account.UserID)
	}
	return AccountUsage{
		Username:     firstStringField(data, "email", "username", "name"),
		UserID:       userID,
		Quota:        quota,
		UsedQuota:    usedQuota,
		TotalQuota:   totalQuota,
		RequestCount: firstFloat64Field(data, "request_count", "requests", "total_requests"),
		LowBalance:   account.LowBalanceQuota > 0 && quota <= account.LowBalanceQuota,
		Source:       "api/v1/user/profile",
	}, nil
}

func (x5m5xAdapter) ListTokens(ctx context.Context, client *http.Client, account Account, session Session) ([]TokenInfo, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
	if err != nil {
		return nil, err
	}
	body, err := x5m5xRequest(ctx, client, session, http.MethodGet, baseURL+"/api/v1/keys?page=1&page_size=100", nil)
	if err != nil {
		return nil, err
	}
	rows, err := x5m5xDataItems(body, "极速 Key 列表")
	if err != nil {
		return nil, err
	}
	return x5m5xTokenMaps(rows), nil
}

func (x5m5xAdapter) FetchConsoleModels(ctx context.Context, client *http.Client, account Account, session Session) ([]string, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
	if err != nil {
		return nil, err
	}
	body, err := x5m5xRequest(ctx, client, session, http.MethodGet, baseURL+"/api/v1/channels/available", nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Code    any             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !x5m5xOK(parsed.Code) {
		if parsed.Message == "" {
			parsed.Message = "极速可用模型请求失败"
		}
		return nil, errors.New(parsed.Message)
	}
	var groups []struct {
		Platforms []struct {
			SupportedModels []struct {
				Name string `json:"name"`
			} `json:"supported_models"`
		} `json:"platforms"`
	}
	if err := json.Unmarshal(parsed.Data, &groups); err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	models := make([]string, 0)
	for _, group := range groups {
		for _, platform := range group.Platforms {
			for _, model := range platform.SupportedModels {
				name := strings.TrimSpace(model.Name)
				if name == "" {
					continue
				}
				key := strings.ToLower(name)
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				models = append(models, name)
			}
		}
	}
	sort.Strings(models)
	return models, nil
}

func (x5m5xAdapter) FetchTokenKey(ctx context.Context, client *http.Client, account Account, session Session, tokenID string) (string, error) {
	tokenID = strings.TrimSpace(tokenID)
	if tokenID == "" {
		return "", errors.New("missing token_id")
	}
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
	if err != nil {
		return "", err
	}
	body, err := x5m5xRequest(ctx, client, session, http.MethodGet, baseURL+"/api/v1/keys/"+url.PathEscape(tokenID), nil)
	if err != nil {
		return "", err
	}
	data, err := x5m5xDataObject(body, "极速 Key 详情")
	if err != nil {
		return "", err
	}
	key := firstStringField(data, "key", "api_key", "token", "custom_key", "secret")
	if key == "" {
		return "", errors.New("极速 Key 详情没有返回可导入的 API Key")
	}
	return key, nil
}

func (x5m5xAdapter) FetchTokenUsage(ctx context.Context, client *http.Client, account Account, session Session, tokenKey string) (UsageSummary, error) {
	usage, err := (x5m5xAdapter{}).FetchAccountUsage(ctx, client, account, session)
	if err != nil {
		return UsageSummary{}, err
	}
	raw := map[string]any{
		"source":        usage.Source,
		"quota":         usage.Quota,
		"used_quota":    usage.UsedQuota,
		"total_quota":   usage.TotalQuota,
		"request_count": usage.RequestCount,
	}
	return UsageSummary{
		TotalGranted:   usage.TotalQuota,
		TotalUsed:      usage.UsedQuota,
		TotalAvailable: usage.Quota,
		UnlimitedQuota: false,
		Raw:            raw,
	}, nil
}

func (x5m5xAdapter) FetchModels(ctx context.Context, client *http.Client, account Account, tokenKey string) ([]string, error) {
	baseURL, err := normalizeConsoleBaseURL(account.ConsoleBaseURL, AdapterX5M5X)
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
		return nil, fmt.Errorf("极速模型列表 status=%d: %s", resp.StatusCode, truncateRelayText(string(body), 180))
	}
	models := parseNewAPIModels(body)
	if len(models) == 0 {
		return nil, errors.New("极速模型列表为空")
	}
	return models, nil
}

func x5m5xRequest(ctx context.Context, client *http.Client, session Session, method string, endpoint string, body io.Reader) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	accessToken := strings.TrimSpace(session.AccessToken)
	if accessToken == "" {
		return nil, errors.New("极速登录态缺少 access_token")
	}
	tokenType := strings.TrimSpace(session.TokenType)
	if tokenType == "" {
		tokenType = "Bearer"
	}
	req.Header.Set("Authorization", tokenType+" "+accessToken)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("极速控制台 unauthorized status=%d", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("极速控制台 status=%d: %s", resp.StatusCode, truncateRelayText(string(respBody), 180))
	}
	return respBody, nil
}

func x5m5xDataObject(body []byte, subject string) (map[string]any, error) {
	var parsed struct {
		Code    any            `json:"code"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !x5m5xOK(parsed.Code) {
		if parsed.Message == "" {
			parsed.Message = subject + "请求失败"
		}
		return nil, errors.New(parsed.Message)
	}
	if parsed.Data == nil {
		parsed.Data = map[string]any{}
	}
	return parsed.Data, nil
}

func x5m5xDataItems(body []byte, subject string) ([]map[string]any, error) {
	var parsed struct {
		Code    any             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !x5m5xOK(parsed.Code) {
		if parsed.Message == "" {
			parsed.Message = subject + "请求失败"
		}
		return nil, errors.New(parsed.Message)
	}
	var page struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(parsed.Data, &page); err == nil && page.Items != nil {
		return page.Items, nil
	}
	var rows []map[string]any
	if err := json.Unmarshal(parsed.Data, &rows); err == nil {
		return rows, nil
	}
	return []map[string]any{}, nil
}

func x5m5xTokenMaps(rows []map[string]any) []TokenInfo {
	items := make([]TokenInfo, 0, len(rows))
	for _, row := range rows {
		id := stringify(row["id"])
		if id == "" {
			continue
		}
		key := firstStringField(row, "key", "api_key", "token", "custom_key", "secret")
		quota := firstFloat64Field(row, "quota", "total_quota", "limit_quota")
		used := firstFloat64Field(row, "used_quota", "quota_used", "used", "usage")
		remain := firstFloat64Field(row, "remain_quota", "remaining_quota", "available_quota", "balance")
		if remain <= 0 && quota > 0 {
			remain = quota - used
			if remain < 0 {
				remain = 0
			}
		}
		group := firstStringField(row, "group", "group_name", "platform")
		if group == "" {
			group = stringify(row["group_id"])
		}
		items = append(items, TokenInfo{
			ID:                 id,
			Name:               firstStringField(row, "name", "title"),
			Status:             int(firstFloat64Field(row, "status")),
			Group:              group,
			KeyMasked:          maskRelaySecret(key),
			RemainQuota:        remain,
			UsedQuota:          used,
			UnlimitedQuota:     quota <= 0 && !boolField(row, "quota_limited"),
			ModelLimitsEnabled: boolField(row, "model_limits_enabled"),
			ExpiredTime:        int64(firstFloat64Field(row, "expired_time", "expires_at", "expire_at")),
		})
	}
	return items
}

func x5m5xOK(code any) bool {
	switch value := code.(type) {
	case nil:
		return true
	case bool:
		return value
	case float64:
		return value == 0
	case int:
		return value == 0
	case int64:
		return value == 0
	case json.Number:
		parsed, err := value.Int64()
		return err == nil && parsed == 0
	case string:
		trimmed := strings.TrimSpace(strings.ToLower(value))
		return trimmed == "" || trimmed == "0" || trimmed == "success" || trimmed == "ok"
	default:
		return false
	}
}

func firstFloat64Field(raw map[string]any, keys ...string) float64 {
	for _, key := range keys {
		if value := float64Field(raw, key); value != 0 {
			return value
		}
	}
	return 0
}

func firstStringField(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringField(raw, key); value != "" {
			return value
		}
		if rawValue, ok := raw[key]; ok {
			if value := stringify(rawValue); value != "" && value != "<nil>" {
				return value
			}
		}
	}
	return ""
}

func maskRelaySecret(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= 10 {
		return strings.Repeat("*", len(runes))
	}
	return string(runes[:4]) + "****" + string(runes[len(runes)-4:])
}

func truncateRelayText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
