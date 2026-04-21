package app

// 会议（腾讯会议链接广播）模块
// 独立职责：
//   1. 解析 meeting.tencent.com/dm/<shortid> 落地页的 __NEXT_DATA__ 并 Base64 解码
//   2. 主群群主/管理员发布会议；全部主群成员可见
//   3. 通过 hub 向目标主群成员推送 im.meeting.created / im.meeting.deleted 事件
// 本模块失败（解析不可用/广播异常）不影响其他 IM 功能；失败时客户端可降级为"手动录入"发布或依赖轮询。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	tencentMeetingFetchTimeout = 6 * time.Second
	tencentMeetingUserAgent    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

var (
	tencentMeetingShortIDRegex   = regexp.MustCompile(`^https?://meeting\.tencent\.com/(?:dm|dw|p)/([A-Za-z0-9_\-]+)`)
	tencentMeetingNextDataRegex  = regexp.MustCompile(`(?s)<script id="__NEXT_DATA__" type="application/json">(.*?)</script>`)
)

// MeetingItem 是对外暴露的会议卡片对象（用于列表 / 发布响应 / WebSocket payload）
type MeetingItem struct {
	ID                int64  `json:"id"`
	URL               string `json:"url"`
	ShortID           string `json:"short_id,omitempty"`
	MeetingCode       string `json:"meeting_code,omitempty"`
	Subject           string `json:"subject"`
	BeginTime         string `json:"begin_time,omitempty"`
	EndTime           string `json:"end_time,omitempty"`
	CreatorNickname   string `json:"creator_nickname,omitempty"`
	HasPassword       bool   `json:"has_password"`
	MeetingPassword   string `json:"meeting_password,omitempty"`
	Mtoken            string `json:"mtoken,omitempty"`
	SenderUsername    string `json:"sender_username,omitempty"`
	SenderDisplayName string `json:"sender_display_name,omitempty"`
	GroupKey          string `json:"group_key,omitempty"`
	CreatedAt         string `json:"created_at,omitempty"`
	IsRead            bool   `json:"is_read"`
}

// MeetingParsedInfo 是 /im/api/meetings/preview 返回的解析结果
type MeetingParsedInfo struct {
	URL             string `json:"url"`
	ShortID         string `json:"short_id,omitempty"`
	MeetingCode     string `json:"meeting_code,omitempty"`
	Subject         string `json:"subject,omitempty"`
	BeginTime       string `json:"begin_time,omitempty"`
	EndTime         string `json:"end_time,omitempty"`
	CreatorNickname string `json:"creator_nickname,omitempty"`
	HasPassword     bool   `json:"has_password"`
	Mtoken          string `json:"mtoken,omitempty"`
}

// tencentMeetingNextData 对应落地页 __NEXT_DATA__ 中与我们相关的子树
type tencentMeetingNextData struct {
	Props struct {
		PageProps struct {
			MeetingInfo struct {
				MeetingCode     string `json:"meeting_code"`
				Subject         string `json:"subject"`          // Base64
				BeginTime       string `json:"begin_time"`       // Unix seconds (string)
				EndTime         string `json:"end_time"`         // Unix seconds (string)
				HasPassword     bool   `json:"has_password"`
				CreatorNickname string `json:"creator_nickname"` // Base64
			} `json:"meetingInfo"`
			Params struct {
				ShortID string `json:"shortid"`
				Mtoken  string `json:"mtoken"`
			} `json:"params"`
			ErrorCode int `json:"errorCode"`
		} `json:"pageProps"`
	} `json:"props"`
}

// normalizeTencentMeetingURL 清理 query/hash，并校验必须是腾讯会议分享链接
func normalizeTencentMeetingURL(raw string) string {
	u := strings.TrimSpace(raw)
	if u == "" {
		return ""
	}
	if idx := strings.IndexAny(u, "?#"); idx > 0 {
		u = u[:idx]
	}
	if !tencentMeetingShortIDRegex.MatchString(u) {
		return ""
	}
	return u
}

func extractTencentMeetingShortID(url string) string {
	match := tencentMeetingShortIDRegex.FindStringSubmatch(url)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func decodeTencentBase64Text(encoded string) string {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return ""
	}
	if b, err := base64.StdEncoding.DecodeString(encoded); err == nil {
		return strings.TrimSpace(string(b))
	}
	if b, err := base64.RawStdEncoding.DecodeString(encoded); err == nil {
		return strings.TrimSpace(string(b))
	}
	if b, err := base64.URLEncoding.DecodeString(encoded); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

func unixSecondsStringToRFC3339(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	seconds, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || seconds <= 0 {
		return ""
	}
	return time.Unix(seconds, 0).UTC().Format(time.RFC3339)
}

// parseTencentMeetingShare 抓取分享链接 → 提取 __NEXT_DATA__ → 解码字段
// 失败返回 nil, error；调用方应降级为手动录入
func parseTencentMeetingShare(ctx context.Context, rawURL string) (*MeetingParsedInfo, error) {
	url := normalizeTencentMeetingURL(rawURL)
	if url == "" {
		return nil, errors.New("不是有效的腾讯会议分享链接")
	}
	shortID := extractTencentMeetingShortID(url)

	fetchCtx, cancel := context.WithTimeout(ctx, tencentMeetingFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", tencentMeetingUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")

	client := &http.Client{Timeout: tencentMeetingFetchTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("抓取腾讯会议页失败 status=%d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	match := tencentMeetingNextDataRegex.FindSubmatch(body)
	if len(match) < 2 {
		return nil, errors.New("__NEXT_DATA__ 未找到（腾讯可能已更新前端结构）")
	}
	var nd tencentMeetingNextData
	if err := json.Unmarshal(match[1], &nd); err != nil {
		return nil, err
	}
	if nd.Props.PageProps.ErrorCode != 0 {
		return nil, fmt.Errorf("会议无效或已过期（error_code=%d）", nd.Props.PageProps.ErrorCode)
	}
	info := nd.Props.PageProps.MeetingInfo
	params := nd.Props.PageProps.Params
	if shortID == "" {
		shortID = strings.TrimSpace(params.ShortID)
	}
	return &MeetingParsedInfo{
		URL:             url,
		ShortID:         shortID,
		MeetingCode:     strings.TrimSpace(info.MeetingCode),
		Subject:         decodeTencentBase64Text(info.Subject),
		BeginTime:       unixSecondsStringToRFC3339(info.BeginTime),
		EndTime:         unixSecondsStringToRFC3339(info.EndTime),
		CreatorNickname: decodeTencentBase64Text(info.CreatorNickname),
		HasPassword:     info.HasPassword,
		Mtoken:          strings.TrimSpace(params.Mtoken),
	}, nil
}

// ============================ 权限 & 可见性 ============================

// canPublishMeeting 是否有资格发布会议
//   条件（任一）：当前用户是某白名单主群 owner_username；或是其 admin 且未撤销
func (a *App) canPublishMeeting(ctx context.Context, username string) (bool, error) {
	normalized := strings.ToLower(strings.TrimSpace(username))
	if normalized == "" {
		return false, nil
	}
	var allowed bool
	err := a.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM im_conversation c
			WHERE c.conversation_type = 'group'
			  AND c.conversation_key LIKE 'group:admin_whitelist:%'
			  AND c.deleted_at IS NULL
			  AND (
				LOWER(COALESCE(c.owner_username, '')) = $1
				OR EXISTS (
					SELECT 1 FROM im_conversation_admin ca
					WHERE ca.conversation_id = c.id
					  AND LOWER(ca.username) = $1
					  AND ca.revoked_at IS NULL
				)
			  )
		)`, normalized).Scan(&allowed)
	if err != nil {
		return false, err
	}
	return allowed, nil
}

// listWhitelistGroupMemberUsernames 指定主群 conversation_key 的活跃成员
// groupKey=="" 代表全部白名单主群成员合并去重
func (a *App) listWhitelistGroupMemberUsernames(ctx context.Context, groupKey string) (map[string]struct{}, error) {
	key := strings.ToLower(strings.TrimSpace(groupKey))
	query := `
		SELECT DISTINCT LOWER(m.username)
		FROM im_conversation c
		JOIN im_conversation_member m ON m.conversation_id = c.id AND m.left_at IS NULL
		WHERE c.conversation_type = 'group'
		  AND c.conversation_key LIKE 'group:admin_whitelist:%'
		  AND c.deleted_at IS NULL`
	args := []any{}
	if key != "" {
		query += ` AND LOWER(c.conversation_key) = $1`
		args = append(args, key)
	}
	rows, err := a.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := map[string]struct{}{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		u = strings.TrimSpace(u)
		if u != "" {
			set[u] = struct{}{}
		}
	}
	return set, rows.Err()
}

// ============================ DB CRUD ============================

type meetingPublishInput struct {
	URL               string
	ShortID           string
	MeetingCode       string
	Subject           string
	BeginTime         string
	EndTime           string
	CreatorNickname   string
	HasPassword       bool
	MeetingPassword   string
	Mtoken            string
	SenderUsername    string
	SenderDisplayName string
	GroupKey          string
}

func (a *App) dbMeetingInsert(ctx context.Context, input meetingPublishInput) (MeetingItem, error) {
	var item MeetingItem
	var beginTime, endTime *time.Time
	if t, err := time.Parse(time.RFC3339, input.BeginTime); err == nil {
		beginTime = &t
	}
	if t, err := time.Parse(time.RFC3339, input.EndTime); err == nil {
		endTime = &t
	}
	var createdAt time.Time
	err := a.db.QueryRow(ctx, `
		INSERT INTO im_meetings (
			url, short_id, meeting_code, subject, begin_time, end_time,
			creator_nickname, has_password, meeting_password, mtoken,
			sender_username, sender_display_name, group_key
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING id, created_at`,
		input.URL, input.ShortID, input.MeetingCode, input.Subject,
		beginTime, endTime,
		input.CreatorNickname, input.HasPassword, input.MeetingPassword, input.Mtoken,
		input.SenderUsername, input.SenderDisplayName, input.GroupKey,
	).Scan(&item.ID, &createdAt)
	if err != nil {
		return item, err
	}
	item.URL = input.URL
	item.ShortID = input.ShortID
	item.MeetingCode = input.MeetingCode
	item.Subject = input.Subject
	item.BeginTime = input.BeginTime
	item.EndTime = input.EndTime
	item.CreatorNickname = input.CreatorNickname
	item.HasPassword = input.HasPassword
	item.MeetingPassword = input.MeetingPassword
	item.Mtoken = input.Mtoken
	item.SenderUsername = input.SenderUsername
	item.SenderDisplayName = input.SenderDisplayName
	item.GroupKey = input.GroupKey
	item.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return item, nil
}

func (a *App) dbMeetingList(ctx context.Context, viewer string, limit int) ([]MeetingItem, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	normalized := strings.ToLower(strings.TrimSpace(viewer))
	rows, err := a.db.Query(ctx, `
		SELECT m.id, m.url, m.short_id, m.meeting_code, m.subject,
		       m.begin_time, m.end_time, m.creator_nickname, m.has_password,
		       m.meeting_password, m.mtoken,
		       m.sender_username, m.sender_display_name, m.group_key, m.created_at,
		       (r.user_username IS NOT NULL) AS is_read
		FROM im_meetings m
		LEFT JOIN im_meeting_reads r
		       ON r.meeting_id = m.id AND LOWER(r.user_username) = $1
		WHERE (m.group_key = '' OR LOWER(m.group_key) IN (
		         SELECT DISTINCT LOWER(c.conversation_key)
		         FROM im_conversation c
		         JOIN im_conversation_member cm ON cm.conversation_id = c.id AND cm.left_at IS NULL
		         WHERE c.conversation_type = 'group'
		           AND c.conversation_key LIKE 'group:admin_whitelist:%'
		           AND c.deleted_at IS NULL
		           AND LOWER(cm.username) = $1
		      ))
		ORDER BY m.created_at DESC
		LIMIT $2`, normalized, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]MeetingItem, 0, limit)
	unread := 0
	for rows.Next() {
		var m MeetingItem
		var beginTime, endTime, createdAt *time.Time
		if err := rows.Scan(&m.ID, &m.URL, &m.ShortID, &m.MeetingCode, &m.Subject,
			&beginTime, &endTime, &m.CreatorNickname, &m.HasPassword,
			&m.MeetingPassword, &m.Mtoken,
			&m.SenderUsername, &m.SenderDisplayName, &m.GroupKey, &createdAt,
			&m.IsRead); err != nil {
			return nil, 0, err
		}
		if beginTime != nil {
			m.BeginTime = beginTime.UTC().Format(time.RFC3339)
		}
		if endTime != nil {
			m.EndTime = endTime.UTC().Format(time.RFC3339)
		}
		if createdAt != nil {
			m.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		}
		if !m.IsRead {
			unread++
		}
		items = append(items, m)
	}
	return items, unread, rows.Err()
}

func (a *App) dbMeetingGet(ctx context.Context, id int64) (MeetingItem, error) {
	var m MeetingItem
	var beginTime, endTime, createdAt *time.Time
	err := a.db.QueryRow(ctx, `
		SELECT id, url, short_id, meeting_code, subject, begin_time, end_time,
		       creator_nickname, has_password, meeting_password, mtoken,
		       sender_username, sender_display_name, group_key, created_at
		FROM im_meetings WHERE id = $1`, id).Scan(
		&m.ID, &m.URL, &m.ShortID, &m.MeetingCode, &m.Subject,
		&beginTime, &endTime, &m.CreatorNickname, &m.HasPassword,
		&m.MeetingPassword, &m.Mtoken,
		&m.SenderUsername, &m.SenderDisplayName, &m.GroupKey, &createdAt,
	)
	if err != nil {
		return m, err
	}
	if beginTime != nil {
		m.BeginTime = beginTime.UTC().Format(time.RFC3339)
	}
	if endTime != nil {
		m.EndTime = endTime.UTC().Format(time.RFC3339)
	}
	if createdAt != nil {
		m.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	}
	return m, nil
}

func (a *App) dbMeetingDelete(ctx context.Context, id int64) error {
	_, err := a.db.Exec(ctx, `DELETE FROM im_meetings WHERE id = $1`, id)
	return err
}

func (a *App) dbMeetingMarkRead(ctx context.Context, meetingID int64, username string) error {
	normalized := strings.ToLower(strings.TrimSpace(username))
	if normalized == "" || meetingID <= 0 {
		return errors.New("invalid read params")
	}
	_, err := a.db.Exec(ctx, `
		INSERT INTO im_meeting_reads (user_username, meeting_id)
		VALUES ($1, $2)
		ON CONFLICT (user_username, meeting_id) DO NOTHING`, normalized, meetingID)
	return err
}

func (a *App) dbMeetingMarkAllRead(ctx context.Context, username string) error {
	normalized := strings.ToLower(strings.TrimSpace(username))
	if normalized == "" {
		return nil
	}
	_, err := a.db.Exec(ctx, `
		INSERT INTO im_meeting_reads (user_username, meeting_id)
		SELECT $1, m.id FROM im_meetings m
		WHERE NOT EXISTS (
		    SELECT 1 FROM im_meeting_reads
		    WHERE user_username = $1 AND meeting_id = m.id
		)`, normalized)
	return err
}

// ============================ 广播 ============================

func (a *App) broadcastMeetingEvent(ctx context.Context, item MeetingItem, eventType string) {
	memberSet, err := a.listWhitelistGroupMemberUsernames(ctx, item.GroupKey)
	if err != nil || len(memberSet) == 0 {
		return
	}
	payload := map[string]any{
		"type":    eventType,
		"payload": item,
	}
	a.broadcastUsernames(memberSet, payload)
}

// ============================ HTTP Handlers ============================

type meetingPreviewRequest struct {
	URL string `json:"url"`
}

// POST /im/api/meetings/preview
func (a *App) handleMeetingPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	allowed, err := a.canPublishMeeting(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "仅主群群主或管理员可发布会议"})
		return
	}
	var req meetingPreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	info, perr := parseTencentMeetingShare(r.Context(), req.URL)
	if perr != nil {
		// 解析失败：返回 parsed:false + 原 URL 校验态，允许前端降级手填
		normalizedURL := normalizeTencentMeetingURL(req.URL)
		writeJSON(w, http.StatusOK, map[string]any{
			"success":   true,
			"parsed":    false,
			"url":       normalizedURL,
			"short_id":  extractTencentMeetingShortID(normalizedURL),
			"error":     perr.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"parsed":  true,
		"info":    info,
	})
}

type meetingPublishRequest struct {
	URL             string `json:"url"`
	ShortID         string `json:"short_id"`
	MeetingCode     string `json:"meeting_code"`
	Subject         string `json:"subject"`
	BeginTime       string `json:"begin_time"`
	EndTime         string `json:"end_time"`
	CreatorNickname string `json:"creator_nickname"`
	HasPassword     bool   `json:"has_password"`
	MeetingPassword string `json:"meeting_password"`
	Mtoken          string `json:"mtoken"`
	GroupKey        string `json:"group_key"`
}

// GET  /im/api/meetings           列表
// POST /im/api/meetings           发布
func (a *App) handleMeetings(w http.ResponseWriter, r *http.Request) {
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.handleMeetingList(w, r, username)
	case http.MethodPost:
		a.handleMeetingPublish(w, r, username)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
	}
}

func (a *App) handleMeetingList(w http.ResponseWriter, r *http.Request, username string) {
	limit := 30
	if ls := strings.TrimSpace(r.URL.Query().Get("limit")); ls != "" {
		if v, err := strconv.Atoi(ls); err == nil && v > 0 {
			limit = v
		}
	}
	canPublish, _ := a.canPublishMeeting(r.Context(), username)
	items, unread, err := a.dbMeetingList(r.Context(), username, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":      true,
		"items":        items,
		"unread_count": unread,
		"can_publish":  canPublish,
	})
}

func (a *App) handleMeetingPublish(w http.ResponseWriter, r *http.Request, username string) {
	allowed, err := a.canPublishMeeting(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "仅主群群主或管理员可发布会议"})
		return
	}
	var req meetingPublishRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	normalizedURL := normalizeTencentMeetingURL(req.URL)
	if normalizedURL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "会议链接不合法"})
		return
	}
	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "会议主题不能为空"})
		return
	}
	meetingCode := strings.TrimSpace(req.MeetingCode)
	if meetingCode == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "会议号不能为空"})
		return
	}
	meetingPassword := strings.TrimSpace(req.MeetingPassword)
	if req.HasPassword && meetingPassword == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "该会议需要密码，请输入入会密码"})
		return
	}
	shortID := strings.TrimSpace(req.ShortID)
	if shortID == "" {
		shortID = extractTencentMeetingShortID(normalizedURL)
	}
	groupKey := strings.ToLower(strings.TrimSpace(req.GroupKey))
	if groupKey != "" {
		var ok bool
		if err := a.db.QueryRow(r.Context(), `
			SELECT EXISTS (
				SELECT 1 FROM im_conversation c
				WHERE LOWER(c.conversation_key) = $1
				  AND c.conversation_type = 'group'
				  AND c.deleted_at IS NULL
				  AND (
					LOWER(COALESCE(c.owner_username, '')) = $2
					OR EXISTS (
						SELECT 1 FROM im_conversation_admin ca
						WHERE ca.conversation_id = c.id
						  AND LOWER(ca.username) = $2
						  AND ca.revoked_at IS NULL
					)
				  )
			)`, groupKey, strings.ToLower(username)).Scan(&ok); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		if !ok {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "无权向该主群发布会议"})
			return
		}
	}
	senderDisplay := a.fetchDisplayName(r.Context(), username)
	item, err := a.dbMeetingInsert(r.Context(), meetingPublishInput{
		URL:               normalizedURL,
		ShortID:           shortID,
		MeetingCode:       meetingCode,
		Subject:           subject,
		BeginTime:         strings.TrimSpace(req.BeginTime),
		EndTime:           strings.TrimSpace(req.EndTime),
		CreatorNickname:   strings.TrimSpace(req.CreatorNickname),
		HasPassword:       req.HasPassword,
		MeetingPassword:   meetingPassword,
		Mtoken:            strings.TrimSpace(req.Mtoken),
		SenderUsername:    strings.ToLower(strings.TrimSpace(username)),
		SenderDisplayName: senderDisplay,
		GroupKey:          groupKey,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	// 发布者自己默认已读
	_ = a.dbMeetingMarkRead(r.Context(), item.ID, username)
	item.IsRead = true

	// 异步广播：失败不影响入库
	go func(m MeetingItem) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.broadcastMeetingEvent(ctx, m, "im.meeting.created")
	}(item)

	writeJSON(w, http.StatusOK, map[string]any{"success": true, "item": item})
}

type meetingReadRequest struct {
	MeetingID int64 `json:"meeting_id"`
	All       bool  `json:"all"`
}

// POST /im/api/meetings/read
func (a *App) handleMeetingRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req meetingReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.All {
		if err := a.dbMeetingMarkAllRead(r.Context(), username); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	} else if req.MeetingID > 0 {
		if err := a.dbMeetingMarkRead(r.Context(), req.MeetingID, username); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	} else {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "meeting_id required"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

type meetingDeleteRequest struct {
	MeetingID int64 `json:"meeting_id"`
}

// POST /im/api/meetings/delete
func (a *App) handleMeetingDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req meetingDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MeetingID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	existing, err := a.dbMeetingGet(r.Context(), req.MeetingID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "会议不存在"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	normalized := strings.ToLower(strings.TrimSpace(username))
	allowed := strings.ToLower(existing.SenderUsername) == normalized
	if !allowed {
		ok, err := a.canPublishMeeting(r.Context(), username)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		allowed = ok
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "无权删除该会议"})
		return
	}
	if err := a.dbMeetingDelete(r.Context(), existing.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	// 异步广播删除事件给原会议可见群成员
	go func(m MeetingItem) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.broadcastMeetingEvent(ctx, m, "im.meeting.deleted")
	}(existing)
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
