package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"im_server/internal/config"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultAvatarStyle = "thumbs"

type App struct {
	cfg      config.Config
	db       *pgxpool.Pool
	hub      *Hub
	server   *http.Server
	upgrader websocket.Upgrader
}

type Hub struct {
	mu    sync.RWMutex
	conns map[string]map[*HubConn]struct{}
}

type HubConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type BootstrapResponse struct {
	Enabled           bool   `json:"enabled"`
	Allowed           bool   `json:"allowed"`
	Username          string `json:"username"`
	DisplayName       string `json:"display_name"`
	AvatarURL         string `json:"avatar_url,omitempty"`
	RetentionDays     int    `json:"retention_days"`
	StoreEncoding     string `json:"store_encoding"`
	CompressMinBytes  int    `json:"compress_min_bytes"`
}

type SessionItem struct {
	ConversationID     int64  `json:"conversation_id"`
	ConversationType   string `json:"conversation_type"`
	ConversationTitle  string `json:"conversation_title,omitempty"`
	AvatarURL          string `json:"avatar_url,omitempty"`
	OwnerUsername      string `json:"owner_username,omitempty"`
	MemberCount        int64  `json:"member_count"`
	MembersPreview     []SessionMemberItem `json:"members_preview,omitempty"`
	PeerUsername       string `json:"peer_username,omitempty"`
	PeerDisplayName    string `json:"peer_display_name,omitempty"`
	PinType            string `json:"pin_type,omitempty"`
	PinnedAt           string `json:"pinned_at,omitempty"`
	IsPinned           bool   `json:"is_pinned"`
	LastMessageID      int64  `json:"last_message_id,omitempty"`
	LastMessagePreview string `json:"last_message_preview,omitempty"`
	LastMessageAt      string `json:"last_message_at,omitempty"`
	UnreadCount        int64  `json:"unread_count"`
}

type MessageItem struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	SenderUsername string `json:"sender_username"`
	SenderAvatarURL string `json:"sender_avatar_url,omitempty"`
	SeqNo          int64  `json:"seq_no"`
	MessageType    string `json:"message_type"`
	Content        string `json:"content"`
	ContentPreview string `json:"content_preview"`
	Status         string `json:"status"`
	SentAt         string `json:"sent_at"`
	Read           bool   `json:"read"`
	ReadProgress   *MessageReadProgressSummary `json:"read_progress,omitempty"`
}

type UserProfileItem struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarStyle string `json:"avatar_style"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

type ContactItem struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

type sendMessageRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Content        string `json:"content"`
}

type directSessionRequest struct {
	TargetUsername string `json:"target_username"`
}

type recallMessageRequest struct {
	MessageID int64 `json:"message_id"`
}

type wsEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type wsReadPayload struct {
	ConversationID int64 `json:"conversation_id"`
	SeqNo          int64 `json:"seq_no"`
}

func New(cfg config.Config) (*App, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	app := &App{
		cfg: cfg,
		db:  pool,
		hub: &Hub{conns: map[string]map[*HubConn]struct{}{}},
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				origin := strings.TrimSpace(r.Header.Get("Origin"))
				if origin == "" {
					return true
				}
				return origin == cfg.AllowedOrigin
			},
		},
	}
	if err := app.ensureSchema(ctx); err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/im/api/bootstrap", app.handleBootstrap)
	mux.HandleFunc("/im/api/contacts", app.handleContacts)
	mux.HandleFunc("/im/api/profile", app.handleProfile)
	mux.HandleFunc("/im/api/profile/avatar/refresh", app.handleProfileAvatarRefresh)
	mux.HandleFunc("/im/api/sessions", app.handleSessions)
	mux.HandleFunc("/im/api/sessions/members", app.handleSessionMembers)
	mux.HandleFunc("/im/api/sessions/group_profile", app.handleSessionGroupProfile)
	mux.HandleFunc("/im/api/sessions/settings", app.handleSessionSettings)
	mux.HandleFunc("/im/api/sessions/members/add", app.handleSessionMembersAdd)
	mux.HandleFunc("/im/api/sessions/members/remove", app.handleSessionMembersRemove)
	mux.HandleFunc("/im/api/sessions/history/clear", app.handleSessionHistoryClear)
	mux.HandleFunc("/im/api/sessions/history/clear-member", app.handleSessionMemberHistoryClear)
	mux.HandleFunc("/im/api/sessions/hide", app.handleSessionHide)
	mux.HandleFunc("/im/api/sessions/direct", app.handleDirectSession)
	mux.HandleFunc("/im/api/sessions/pin", app.handleSessionPin)
	mux.HandleFunc("/im/api/messages", app.handleMessages)
	mux.HandleFunc("/im/api/messages/read_progress", app.handleMessageReadProgress)
	mux.HandleFunc("/im/api/messages/recall", app.handleRecallMessage)
	mux.HandleFunc("/im/internal/whitelist_groups/sync", app.handleInternalWhitelistGroupSync)
	mux.HandleFunc("/im/internal/group_profile", app.handleInternalGroupProfile)
	mux.HandleFunc("/im/internal/group_admins/replace", app.handleInternalGroupAdminsReplace)
	mux.HandleFunc("/im/internal/group_owner/transfer", app.handleInternalGroupOwnerTransfer)
	mux.HandleFunc("/im/ws", app.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	app.server = &http.Server{
		Addr:    cfg.Addr,
		Handler: app.withCommonHeaders(mux),
	}
	return app, nil
}

func (a *App) Run() error {
	go a.runWhitelistGroupSelfHeal()
	log.Printf("im server listen on %s", a.cfg.Addr)
	return a.server.ListenAndServe()
}

func (a *App) runWhitelistGroupSelfHeal() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	syncedCount, err := a.syncWhitelistGroups(ctx, "")
	if err != nil {
		log.Printf("im whitelist main group self heal failed: %v", err)
		return
	}
	log.Printf("im whitelist main group self heal synced owners=%d", syncedCount)
}

func (a *App) withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", a.cfg.AllowedOrigin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) ensureSchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS im_conversation (
			id BIGSERIAL PRIMARY KEY,
			conversation_type TEXT NOT NULL,
			conversation_key TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL DEFAULT '',
			avatar_url TEXT NOT NULL DEFAULT '',
			owner_username TEXT NOT NULL DEFAULT '',
			last_message_id BIGINT,
			last_message_preview TEXT NOT NULL DEFAULT '',
			last_message_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		`ALTER TABLE im_conversation ADD COLUMN IF NOT EXISTS hidden_for_all BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE im_conversation ADD COLUMN IF NOT EXISTS purged_before_seq_no BIGINT NOT NULL DEFAULT 0`,
		`CREATE TABLE IF NOT EXISTS im_conversation_member (
			id BIGSERIAL PRIMARY KEY,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			username TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'member',
			joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
			left_at TIMESTAMP,
			last_read_seq_no BIGINT NOT NULL DEFAULT 0,
			last_read_at TIMESTAMP,
			mute_until TIMESTAMP,
			is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
			pin_type TEXT NOT NULL DEFAULT 'none',
			pinned_at TIMESTAMP,
			is_archived BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_message (
			id BIGSERIAL PRIMARY KEY,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			sender_username TEXT NOT NULL,
			seq_no BIGINT NOT NULL,
			message_type TEXT NOT NULL DEFAULT 'text',
			content_preview TEXT NOT NULL DEFAULT '',
			content_encoding TEXT NOT NULL DEFAULT 'plain',
			content_payload TEXT NOT NULL DEFAULT '',
			content_size_raw INTEGER NOT NULL DEFAULT 0,
			content_size_stored INTEGER NOT NULL DEFAULT 0,
			reply_to_message_id BIGINT,
			status TEXT NOT NULL DEFAULT 'normal',
			sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			deleted_at TIMESTAMP,
			UNIQUE(conversation_id, seq_no)
		)`,
		`CREATE TABLE IF NOT EXISTS im_conversation_admin (
			id BIGSERIAL PRIMARY KEY,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			username TEXT NOT NULL,
			assigned_by TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			revoked_at TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS im_conversation_member_override (
			id BIGSERIAL PRIMARY KEY,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			username TEXT NOT NULL,
			override_type TEXT NOT NULL,
			created_by TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			CHECK (override_type IN ('add', 'remove')),
			UNIQUE(conversation_id, username)
		)`,
		`CREATE TABLE IF NOT EXISTS im_user_profile (
			username TEXT PRIMARY KEY,
			avatar_style TEXT NOT NULL DEFAULT 'thumbs',
			avatar_seed TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE im_conversation_member ADD COLUMN IF NOT EXISTS left_at TIMESTAMP`,
		`ALTER TABLE im_conversation_member ADD COLUMN IF NOT EXISTS pin_type TEXT NOT NULL DEFAULT 'none'`,
		`ALTER TABLE im_conversation_member ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP`,
		`ALTER TABLE im_conversation_member DROP CONSTRAINT IF EXISTS im_conversation_member_conversation_id_username_key`,
		`UPDATE im_conversation_member SET pin_type = CASE WHEN is_pinned THEN 'manual' ELSE 'none' END WHERE COALESCE(pin_type, '') = ''`,
		`UPDATE im_conversation_member SET pinned_at = COALESCE(pinned_at, updated_at, created_at, NOW()) WHERE is_pinned = TRUE AND pinned_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_member_username ON im_conversation_member(username)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_conversation_member_active_unique ON im_conversation_member(conversation_id, username) WHERE left_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_conversation_admin_active_unique ON im_conversation_admin(conversation_id, username) WHERE revoked_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_admin_username ON im_conversation_admin(username)`,
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_member_override_username ON im_conversation_member_override(username)`,
		`CREATE INDEX IF NOT EXISTS idx_im_message_conversation_id ON im_message(conversation_id, seq_no DESC)`,
	}
	for index, stmt := range statements {
		if _, err := a.db.Exec(ctx, stmt); err != nil {
			snippet := strings.Join(strings.Fields(stmt), " ")
			if len(snippet) > 220 {
				snippet = snippet[:220]
			}
			return fmt.Errorf("ensure schema statement #%d failed: %w | sql=%s", index+1, err, snippet)
		}
	}
	return nil
}

func (a *App) resolveUsername(r *http.Request) string {
    headerUsername := strings.ToLower(strings.TrimSpace(r.Header.Get("X-AK-Username")))
    if headerUsername != "" {
        return headerUsername
    }
    queryUsername := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("username")))
    if queryUsername != "" {
        return queryUsername
    }
	cookie, err := r.Cookie(a.cfg.CookieName)
	if err == nil {
		username := strings.ToLower(strings.TrimSpace(cookie.Value))
		if username != "" {
			return username
		}
	}
	return ""
}

func (a *App) requireAllowedUser(r *http.Request) (string, error) {
	username := a.resolveUsername(r)
	if username == "" {
		return "", errors.New("missing username cookie")
	}
	var exists bool
	if err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM user_stats WHERE username = $1)`, username).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		return "", errors.New("user not found")
	}
	var allowed bool
	if err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM authorized_accounts WHERE username = $1 AND status = 'active' AND expire_time > NOW())`, username).Scan(&allowed); err != nil {
		return "", err
	}
	if !allowed {
		return "", errors.New("user not in whitelist")
	}
	return username, nil
}

func (a *App) fetchDisplayName(ctx context.Context, username string) string {
	var displayName string
	_ = a.db.QueryRow(ctx, `SELECT COALESCE(NULLIF(real_name, ''), username) FROM user_stats WHERE username = $1`, username).Scan(&displayName)
	if strings.TrimSpace(displayName) == "" {
		return username
	}
	return displayName
}

func normalizeAvatarStyle(style string) string {
	normalized := strings.ToLower(strings.TrimSpace(style))
	if normalized == "" {
		return defaultAvatarStyle
	}
	if normalized != defaultAvatarStyle {
		return defaultAvatarStyle
	}
	return normalized
}

func buildAvatarSeed(username string, seed string) string {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	normalizedSeed := strings.TrimSpace(seed)
	if normalizedSeed == "" {
		return normalizedUsername
	}
	if normalizedUsername == "" {
		return normalizedSeed
	}
	return normalizedUsername + "::" + normalizedSeed
}

func buildDicebearAvatarURL(style string, seed string) string {
	normalizedStyle := normalizeAvatarStyle(style)
	normalizedSeed := strings.TrimSpace(seed)
	if normalizedSeed == "" {
		normalizedSeed = "user"
	}
	return "https://api.dicebear.com/9.x/" + url.PathEscape(normalizedStyle) + "/svg?seed=" + url.QueryEscape(normalizedSeed) + "&size=128"
}

func randomAvatarSeed() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

func (a *App) loadUserAvatarProfile(ctx context.Context, username string) (string, string, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return defaultAvatarStyle, "", nil
	}
	var avatarStyle string
	var avatarSeed string
	err := a.db.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(avatar_style, ''), $2), COALESCE(avatar_seed, '')
		FROM im_user_profile
		WHERE username = $1`, normalizedUsername, defaultAvatarStyle).Scan(&avatarStyle, &avatarSeed)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return defaultAvatarStyle, "", nil
		}
		return defaultAvatarStyle, "", err
	}
	return normalizeAvatarStyle(avatarStyle), strings.TrimSpace(avatarSeed), nil
}

func (a *App) getUserAvatarURL(ctx context.Context, username string) string {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return ""
	}
	avatarStyle, avatarSeed, err := a.loadUserAvatarProfile(ctx, normalizedUsername)
	if err != nil {
		log.Printf("load user avatar profile failed: username=%s err=%v", normalizedUsername, err)
		avatarStyle = defaultAvatarStyle
		avatarSeed = ""
	}
	return buildDicebearAvatarURL(avatarStyle, buildAvatarSeed(normalizedUsername, avatarSeed))
}

func (a *App) buildUserProfileItem(ctx context.Context, username string) UserProfileItem {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	avatarStyle, avatarSeed, err := a.loadUserAvatarProfile(ctx, normalizedUsername)
	if err != nil {
		log.Printf("build user profile item avatar load failed: username=%s err=%v", normalizedUsername, err)
		avatarStyle = defaultAvatarStyle
		avatarSeed = ""
	}
	return UserProfileItem{
		Username:    normalizedUsername,
		DisplayName: a.fetchDisplayName(ctx, normalizedUsername),
		AvatarStyle: normalizeAvatarStyle(avatarStyle),
		AvatarURL:   buildDicebearAvatarURL(avatarStyle, buildAvatarSeed(normalizedUsername, avatarSeed)),
	}
}

func (a *App) refreshUserAvatarProfile(ctx context.Context, username string) (UserProfileItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return UserProfileItem{}, errors.New("invalid username")
	}
	if _, err := a.db.Exec(ctx, `
		INSERT INTO im_user_profile (username, avatar_style, avatar_seed, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (username) DO UPDATE
		SET avatar_style = EXCLUDED.avatar_style,
			avatar_seed = EXCLUDED.avatar_seed,
			updated_at = NOW()`, normalizedUsername, defaultAvatarStyle, randomAvatarSeed()); err != nil {
		return UserProfileItem{}, err
	}
	return a.buildUserProfileItem(ctx, normalizedUsername), nil
}

func (a *App) findWhitelistConversationID(ctx context.Context, username string) (int64, error) {
	var conversationID int64
	err := a.db.QueryRow(ctx, `
		SELECT c.id
		FROM im_conversation c
		JOIN im_conversation_member cm ON cm.conversation_id = c.id AND cm.username = $1 AND cm.left_at IS NULL
		WHERE c.deleted_at IS NULL
			AND c.conversation_type = 'group'
			AND c.conversation_key LIKE $2
		ORDER BY c.id ASC
		LIMIT 1`, username, whitelistGroupKeyPrefix+"%").Scan(&conversationID)
	if err != nil {
		return 0, err
	}
	return conversationID, nil
}

func (a *App) listWhitelistContacts(ctx context.Context, username string) ([]ContactItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return []ContactItem{}, nil
	}
	conversationID, err := a.findWhitelistConversationID(ctx, normalizedUsername)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return []ContactItem{}, nil
		}
		return nil, err
	}
	meta, err := a.loadConversationMeta(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	members, err := a.loadConversationMemberItems(ctx, conversationID, meta)
	if err != nil {
		return nil, err
	}
	items := make([]ContactItem, 0, len(members))
	for _, member := range members {
		if strings.EqualFold(member.Username, normalizedUsername) {
			continue
		}
		items = append(items, ContactItem{
			Username:    member.Username,
			DisplayName: member.DisplayName,
			AvatarURL:   member.AvatarURL,
		})
	}
	sort.Slice(items, func(left int, right int) bool {
		leftName := strings.TrimSpace(items[left].DisplayName)
		rightName := strings.TrimSpace(items[right].DisplayName)
		if leftName == rightName {
			return items[left].Username < items[right].Username
		}
		return leftName < rightName
	})
	return items, nil
}

func (a *App) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, BootstrapResponse{Enabled: true, Allowed: false})
		return
	}
	profile := a.buildUserProfileItem(r.Context(), username)
	writeJSON(w, http.StatusOK, BootstrapResponse{
		Enabled:          true,
		Allowed:          true,
		Username:         username,
		DisplayName:      profile.DisplayName,
		AvatarURL:        profile.AvatarURL,
		RetentionDays:    30,
		StoreEncoding:    "plain_or_zstd",
		CompressMinBytes: a.cfg.CompressMinBytes,
	})
}

func (a *App) handleContacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	items, err := a.listWhitelistContacts(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": a.buildUserProfileItem(r.Context(), username)})
}

func (a *App) handleProfileAvatarRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	item, err := a.refreshUserAvatarProfile(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT c.id, c.conversation_type, COALESCE(c.title, '') AS conversation_title, COALESCE(c.avatar_url, '') AS avatar_url, COALESCE(c.owner_username, '') AS owner_username,
			COALESCE((SELECT COUNT(1) FROM im_conversation_member member WHERE member.conversation_id = c.id AND member.left_at IS NULL), 0) AS member_count,
			COALESCE(cm.pin_type, 'none') AS pin_type,
			cm.pinned_at,
			COALESCE(c.last_message_id, 0) AS last_message_id,
			COALESCE(c.last_message_preview, '') AS last_message_preview,
			c.last_message_at,
			COALESCE((SELECT COUNT(1) FROM im_message m2 WHERE m2.conversation_id = c.id AND m2.deleted_at IS NULL AND m2.sender_username <> $1 AND m2.seq_no > COALESCE(cm.last_read_seq_no, 0) AND m2.seq_no > COALESCE(c.purged_before_seq_no, 0) AND m2.sent_at >= cm.joined_at), 0) AS unread_count,
			COALESCE((SELECT peer.username FROM im_conversation_member peer WHERE peer.conversation_id = c.id AND peer.username <> $1 AND peer.left_at IS NULL ORDER BY peer.username LIMIT 1), '') AS peer_username
		FROM im_conversation c
		JOIN im_conversation_member cm ON cm.conversation_id = c.id AND cm.username = $1 AND cm.left_at IS NULL
		WHERE c.deleted_at IS NULL AND COALESCE(c.hidden_for_all, FALSE) = FALSE
		ORDER BY CASE COALESCE(cm.pin_type, 'none') WHEN 'system' THEN 2 WHEN 'manual' THEN 1 ELSE 0 END DESC,
			COALESCE(cm.pinned_at, c.last_message_at, c.created_at) DESC,
			COALESCE(c.last_message_at, c.created_at) DESC`, username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer rows.Close()
	items := make([]SessionItem, 0)
	for rows.Next() {
		var item SessionItem
		var lastMessageAt *time.Time
		var pinnedAt *time.Time
		if err := rows.Scan(&item.ConversationID, &item.ConversationType, &item.ConversationTitle, &item.AvatarURL, &item.OwnerUsername, &item.MemberCount, &item.PinType, &pinnedAt, &item.LastMessageID, &item.LastMessagePreview, &lastMessageAt, &item.UnreadCount, &item.PeerUsername); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		item.PeerDisplayName = a.fetchDisplayName(r.Context(), item.PeerUsername)
		if item.ConversationType != "group" {
			item.AvatarURL = a.getUserAvatarURL(r.Context(), item.PeerUsername)
		}
		item.IsPinned = item.PinType == "system" || item.PinType == "manual"
		if pinnedAt != nil {
			item.PinnedAt = pinnedAt.Format(time.RFC3339)
		}
		if item.ConversationType == "group" && strings.TrimSpace(item.ConversationTitle) == "" {
			item.ConversationTitle = "内部群聊"
		}
		if item.ConversationType == "group" {
			item.PeerDisplayName = item.ConversationTitle
			item.PeerUsername = ""
			members, membersErr := a.loadConversationMemberItems(r.Context(), item.ConversationID, conversationMeta{
				ID:                item.ConversationID,
				ConversationType:  item.ConversationType,
				ConversationTitle: item.ConversationTitle,
				OwnerUsername:     item.OwnerUsername,
			})
			if membersErr != nil {
				log.Printf("load session members preview failed: conversation_id=%d err=%v", item.ConversationID, membersErr)
			} else {
				item.MembersPreview = sortSessionMembersForPreview(members)
			}
		}
		if lastMessageAt != nil {
			item.LastMessageAt = lastMessageAt.Format(time.RFC3339)
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func sortSessionMembersForPreview(items []SessionMemberItem) []SessionMemberItem {
	if len(items) < 2 {
		return items
	}
	preview := append([]SessionMemberItem(nil), items...)
	roleWeight := func(role string) int {
		switch strings.ToLower(strings.TrimSpace(role)) {
		case "owner":
			return 0
		case "admin":
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(preview, func(left int, right int) bool {
		return roleWeight(preview[left].Role) < roleWeight(preview[right].Role)
	})
	if len(preview) > 9 {
		preview = preview[:9]
	}
	return preview
}

func (a *App) handleDirectSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req directSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	target := strings.ToLower(strings.TrimSpace(req.TargetUsername))
	if target == "" || target == username {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid target username"})
		return
	}
	var targetExists bool
	if err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM user_stats WHERE username = $1)`, target).Scan(&targetExists); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if !targetExists {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "target user not found"})
		return
	}
	var targetAllowed bool
	if err := a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM authorized_accounts WHERE username = $1 AND status = 'active' AND expire_time > NOW())`, target).Scan(&targetAllowed); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if !targetAllowed {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "target user not allowed"})
		return
	}
	conversationID, err := a.ensureDirectConversation(r.Context(), username, target)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation_id": conversationID})
}

func (a *App) ensureDirectConversation(ctx context.Context, username string, target string) (int64, error) {
	users := []string{strings.ToLower(username), strings.ToLower(target)}
	sort.Strings(users)
	key := "direct:" + users[0] + ":" + users[1]
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var conversationID int64
	err = tx.QueryRow(ctx, `SELECT id FROM im_conversation WHERE conversation_key = $1`, key).Scan(&conversationID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if conversationID == 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO im_conversation (conversation_type, conversation_key, owner_username) VALUES ('direct', $1, $2) ON CONFLICT (conversation_key) DO NOTHING`, key, username); err != nil {
			return 0, err
		}
		if err := tx.QueryRow(ctx, `SELECT id FROM im_conversation WHERE conversation_key = $1`, key).Scan(&conversationID); err != nil {
			return 0, err
		}
	}
	for _, member := range users {
		if _, err := tx.Exec(ctx, `INSERT INTO im_conversation_member (conversation_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING`, conversationID, member); err != nil {
			return 0, err
		}
	}
	return conversationID, tx.Commit(ctx)
}

func (a *App) handleMessages(w http.ResponseWriter, r *http.Request) {
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.handleListMessages(w, r, username)
	case http.MethodPost:
		a.handleSendMessage(w, r, username)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
	}
}

func (a *App) handleRecallMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req recallMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.MessageID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid message_id"})
		return
	}
	item, err := a.recallMessage(r.Context(), req.MessageID, username)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(item.ConversationID, map[string]any{"type": "im.message.recalled", "payload": item})
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) handleListMessages(w http.ResponseWriter, r *http.Request, username string) {
	conversationID := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
	if conversationID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing conversation_id"})
		return
	}
	var conversationIDValue int64
	if _, err := fmt.Sscan(conversationID, &conversationIDValue); err != nil || conversationIDValue <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	if !a.ensureConversationMember(r.Context(), conversationID, username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	meta, err := a.loadConversationMeta(r.Context(), conversationIDValue)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "conversation not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT m.id, m.conversation_id, m.sender_username, m.seq_no, m.message_type, m.content_payload, m.content_preview, m.status, m.sent_at
		FROM im_message m
		WHERE m.conversation_id = $1::bigint AND m.deleted_at IS NULL AND m.seq_no > $2
		ORDER BY m.seq_no DESC LIMIT 50`, conversationID, meta.PurgedBeforeSeqNo)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer rows.Close()
	items := make([]MessageItem, 0)
	for rows.Next() {
		var item MessageItem
		var sentAt time.Time
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		item.SentAt = sentAt.Format(time.RFC3339)
		item.SenderAvatarURL = a.getUserAvatarURL(r.Context(), item.SenderUsername)
		items = append(items, item)
	}
	for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
		items[left], items[right] = items[right], items[left]
	}
	members, err := a.listConversationMembers(r.Context(), conversationIDValue)
	if err == nil {
		a.populateMessageReadProgress(items, members, username)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleSendMessage(w http.ResponseWriter, r *http.Request, username string) {
	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if req.ConversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	if !a.ensureConversationMember(r.Context(), fmt.Sprintf("%d", req.ConversationID), username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "empty content"})
		return
	}
	message, err := a.insertMessage(r.Context(), req.ConversationID, username, content)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{
		"type": "im.message.created",
		"payload": message,
	})
	writeJSON(w, http.StatusOK, map[string]any{"item": message})
}

func (a *App) insertMessage(ctx context.Context, conversationID int64, username string, content string) (MessageItem, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return MessageItem{}, err
	}
	defer tx.Rollback(ctx)
	var nextSeqNo int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq_no), 0) + 1 FROM im_message WHERE conversation_id = $1`, conversationID).Scan(&nextSeqNo); err != nil {
		return MessageItem{}, err
	}
	preview := content
	if len([]rune(preview)) > 120 {
		preview = string([]rune(preview)[:120])
	}
	var item MessageItem
	var sentAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO im_message (conversation_id, sender_username, seq_no, content_preview, content_payload, content_size_raw, content_size_stored)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, conversation_id, sender_username, seq_no, message_type, content_payload, content_preview, status, sent_at`,
		conversationID, username, nextSeqNo, preview, content, len(content), len(content),
	).Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt)
	if err != nil {
		return MessageItem{}, err
	}
	item.SentAt = sentAt.Format(time.RFC3339)
	item.SenderAvatarURL = a.getUserAvatarURL(ctx, item.SenderUsername)
	if _, err := tx.Exec(ctx, `UPDATE im_conversation SET last_message_id = $1, last_message_preview = $2, last_message_at = NOW(), updated_at = NOW() WHERE id = $3`, item.ID, item.ContentPreview, conversationID); err != nil {
		return MessageItem{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE im_conversation_member SET last_read_seq_no = GREATEST(last_read_seq_no, $1), last_read_at = NOW(), updated_at = NOW() WHERE conversation_id = $2 AND username = $3`, item.SeqNo, conversationID, username); err != nil {
		return MessageItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MessageItem{}, err
	}
	members, err := a.listConversationMembers(ctx, conversationID)
	if err == nil {
		items := []MessageItem{item}
		a.populateMessageReadProgress(items, members, username)
		item = items[0]
	}
	return item, nil
}

func (a *App) recallMessage(ctx context.Context, messageID int64, username string) (MessageItem, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return MessageItem{}, err
	}
	defer tx.Rollback(ctx)
	var item MessageItem
	var sentAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, conversation_id, sender_username, seq_no, message_type, content_payload, content_preview, status, sent_at
		FROM im_message
		WHERE id = $1 AND deleted_at IS NULL`, messageID).Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt)
	if err != nil {
		return MessageItem{}, errors.New("message not found")
	}
	if item.SenderUsername != username {
		return MessageItem{}, errors.New("forbidden")
	}
	if time.Since(sentAt) > time.Minute {
		return MessageItem{}, errors.New("message recall expired")
	}
	if item.Status == "recalled" {
		return MessageItem{}, errors.New("message already recalled")
	}
	item.Content = ""
	item.ContentPreview = "[消息已撤回]"
	item.Status = "recalled"
	item.SentAt = sentAt.Format(time.RFC3339)
	item.SenderAvatarURL = a.getUserAvatarURL(ctx, item.SenderUsername)
	if _, err := tx.Exec(ctx, `UPDATE im_message SET status = 'recalled', content_preview = $1, content_payload = '', updated_at = NOW() WHERE id = $2`, item.ContentPreview, item.ID); err != nil {
		return MessageItem{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE im_conversation SET last_message_preview = CASE WHEN last_message_id = $1 THEN $2 ELSE last_message_preview END, updated_at = NOW() WHERE id = $3`, item.ID, item.ContentPreview, item.ConversationID); err != nil {
		return MessageItem{}, err
	}
	return item, tx.Commit(ctx)
}

func (a *App) ensureConversationMember(ctx context.Context, conversationID string, username string) bool {
	var exists bool
	_ = a.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM im_conversation_member cm
			JOIN im_conversation c ON c.id = cm.conversation_id
			WHERE cm.conversation_id = $1::bigint
				AND cm.username = $2
				AND cm.left_at IS NULL
				AND c.deleted_at IS NULL
				AND COALESCE(c.hidden_for_all, FALSE) = FALSE
		)`, conversationID, username).Scan(&exists)
	return exists
}

func (a *App) handleWS(w http.ResponseWriter, r *http.Request) {
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &HubConn{conn: conn}
	a.hub.add(username, client)
	defer func() {
		a.hub.remove(username, client)
		client.conn.Close()
	}()
	_ = client.WriteJSON(map[string]any{"type": "im.bootstrap.ready", "payload": map[string]any{"username": username}})
	for {
		var env wsEnvelope
		if err := client.conn.ReadJSON(&env); err != nil {
			return
		}
		switch env.Type {
		case "im.presence.ping":
			_ = client.WriteJSON(map[string]any{"type": "im.presence.pong", "payload": map[string]any{"ts": time.Now().Unix()}})
		case "im.message.send":
			var payload sendMessageRequest
			if err := json.Unmarshal(env.Payload, &payload); err != nil {
				continue
			}
			if payload.ConversationID <= 0 || strings.TrimSpace(payload.Content) == "" {
				continue
			}
			if !a.ensureConversationMember(r.Context(), fmt.Sprintf("%d", payload.ConversationID), username) {
				continue
			}
			item, err := a.insertMessage(r.Context(), payload.ConversationID, username, strings.TrimSpace(payload.Content))
			if err != nil {
				continue
			}
			a.broadcastConversation(payload.ConversationID, map[string]any{"type": "im.message.created", "payload": item})
		case "im.message.read":
			var payload wsReadPayload
			if err := json.Unmarshal(env.Payload, &payload); err != nil {
				continue
			}
			if payload.ConversationID <= 0 || payload.SeqNo <= 0 {
				continue
			}
			if !a.ensureConversationMember(r.Context(), fmt.Sprintf("%d", payload.ConversationID), username) {
				continue
			}
			_, _ = a.db.Exec(r.Context(), `UPDATE im_conversation_member SET last_read_seq_no = GREATEST(last_read_seq_no, $1), last_read_at = NOW(), updated_at = NOW() WHERE conversation_id = $2 AND username = $3`, payload.SeqNo, payload.ConversationID, username)
			a.broadcastConversation(payload.ConversationID, map[string]any{"type": "im.message.read", "payload": payload})
		}
	}
}

func (a *App) broadcastConversation(conversationID int64, payload map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rows, err := a.db.Query(ctx, `SELECT username FROM im_conversation_member WHERE conversation_id = $1 AND left_at IS NULL`, conversationID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			continue
		}
		a.hub.send(username, payload)
	}
}

func (c *HubConn) WriteJSON(payload any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(payload)
}

func (h *Hub) add(username string, conn *HubConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[username] == nil {
		h.conns[username] = map[*HubConn]struct{}{}
	}
	h.conns[username][conn] = struct{}{}
}

func (h *Hub) remove(username string, conn *HubConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[username] == nil {
		return
	}
	delete(h.conns[username], conn)
	if len(h.conns[username]) == 0 {
		delete(h.conns, username)
	}
}

func (h *Hub) send(username string, payload map[string]any) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn := range h.conns[username] {
		_ = conn.WriteJSON(payload)
	}
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func maxInt64(value int64, min int64) int64 {
	if value < min {
		return min
	}
	return value
}
