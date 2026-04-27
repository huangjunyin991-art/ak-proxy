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

var (
	errInvalidMessageType = errors.New("invalid message_type")
	errInvalidEmojiAssetID = errors.New("invalid emoji_asset_id")
	errInvalidVoicePayload = errors.New("invalid voice payload")
	errInvalidImagePayload = errors.New("invalid image payload")
	errInvalidFilePayload = errors.New("invalid file payload")
	errInvalidLocationPayload = errors.New("invalid location payload")
	errEmptyMessageContent = errors.New("empty content")
)

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
	HonorName         string `json:"honor_name,omitempty"`
	AvatarURL         string `json:"avatar_url,omitempty"`
	EmojiAssets       []EmojiAssetItem `json:"emoji_assets,omitempty"`
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
	PeerHonorName      string `json:"peer_honor_name,omitempty"`
	PinType            string `json:"pin_type,omitempty"`
	PinnedAt           string `json:"pinned_at,omitempty"`
	IsPinned           bool   `json:"is_pinned"`
	LastMessageID      int64  `json:"last_message_id,omitempty"`
	LastMessagePreview string `json:"last_message_preview,omitempty"`
	LastMessageAt      string `json:"last_message_at,omitempty"`
	UnreadCount        int64  `json:"unread_count"`
}

type MessageItem struct {
	ID                int64  `json:"id"`
	ConversationID    int64  `json:"conversation_id"`
	SenderUsername    string `json:"sender_username"`
	SenderDisplayName string `json:"sender_display_name,omitempty"`
	SenderHonorName   string `json:"sender_honor_name,omitempty"`
	SenderAvatarURL   string `json:"sender_avatar_url,omitempty"`
	ClientTempID      string `json:"client_temp_id,omitempty"`
	SeqNo             int64  `json:"seq_no"`
	MessageType       string `json:"message_type"`
	Content           string `json:"content"`
	ContentPreview    string `json:"content_preview"`
	Status            string `json:"status"`
	SentAt            string `json:"sent_at"`
	Read              bool   `json:"read"`
	ReadProgress      *MessageReadProgressSummary `json:"read_progress,omitempty"`
}

type UserProfileItem struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	HonorName   string `json:"honor_name,omitempty"`
	Nickname    string `json:"nickname,omitempty"`
	Gender      string `json:"gender,omitempty"`
	AvatarStyle string `json:"avatar_style"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

type UserAvatarHistoryItem struct {
	ID          int64  `json:"id"`
	AvatarStyle string `json:"avatar_style"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	IsFavorite  bool   `json:"is_favorite"`
	CreatedAt   string `json:"created_at"`
}

type ContactItem struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	HonorName   string `json:"honor_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

type sendMessageRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Content        string `json:"content"`
	MessageType    string `json:"message_type"`
	EmojiAssetID   int64  `json:"emoji_asset_id,omitempty"`
	ClientTempID   string `json:"client_temp_id,omitempty"`
}

type directSessionRequest struct {
	TargetUsername string `json:"target_username"`
}

type profileUpdateRequest struct {
	Nickname string `json:"nickname"`
	Gender   string `json:"gender"`
}

type avatarHistoryActionRequest struct {
	HistoryID int64 `json:"history_id"`
}

type avatarHistoryFavoriteRequest struct {
	HistoryID int64 `json:"history_id"`
	Favorite  bool  `json:"favorite"`
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
	if err := app.ensureEmojiDirectories(); err != nil {
		return nil, err
	}
	if err := app.ensureVoiceDirectories(); err != nil {
		return nil, err
	}
	if err := app.ensureImageDirectories(); err != nil {
		return nil, err
	}
	if err := app.ensureFileDirectories(); err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/im/api/bootstrap", app.handleBootstrap)
	mux.HandleFunc("/im/api/contacts", app.handleContacts)
	mux.HandleFunc("/im/api/emoji_assets", app.handleEmojiAssets)
	mux.HandleFunc("/im/api/profile", app.handleProfile)
	mux.HandleFunc("/im/api/profile/avatar/history", app.handleProfileAvatarHistory)
	mux.HandleFunc("/im/api/profile/avatar/refresh", app.handleProfileAvatarRefresh)
	mux.HandleFunc("/im/api/profile/avatar/upload", app.handleProfileAvatarUpload)
	mux.HandleFunc("/im/api/profile/avatar/select", app.handleProfileAvatarSelect)
	mux.HandleFunc("/im/api/profile/avatar/favorite", app.handleProfileAvatarFavorite)
	mux.HandleFunc("/im/api/profile/avatar/remove", app.handleProfileAvatarRemove)
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
	mux.HandleFunc("/im/api/image_upload/config", app.handleImageUploadConfig)
	mux.HandleFunc("/im/api/messages/image", app.handleSendImageMessage)
	mux.HandleFunc("/im/api/messages/file", app.handleSendFileMessage)
	mux.HandleFunc("/im/api/messages/voice", app.handleSendVoiceMessage)
	mux.HandleFunc("/im/api/messages/read_progress", app.handleMessageReadProgress)
	mux.HandleFunc("/im/api/messages/recall", app.handleRecallMessage)
	mux.HandleFunc("/im/api/meetings", app.handleMeetings)
	mux.HandleFunc("/im/api/meetings/preview", app.handleMeetingPreview)
	mux.HandleFunc("/im/api/meetings/read", app.handleMeetingRead)
	mux.HandleFunc("/im/api/meetings/delete", app.handleMeetingDelete)
	mux.HandleFunc("/im/internal/whitelist_groups/sync", app.handleInternalWhitelistGroupSync)
	mux.HandleFunc("/im/internal/group_profile", app.handleInternalGroupProfile)
	mux.HandleFunc("/im/internal/group_admins/replace", app.handleInternalGroupAdminsReplace)
	mux.HandleFunc("/im/internal/group_owner/transfer", app.handleInternalGroupOwnerTransfer)
	mux.HandleFunc("/im/internal/file_assets/config", app.handleInternalFileAssetConfig)
	mux.HandleFunc("/im/internal/image_upload/config", app.handleInternalImageUploadConfig)
	mux.HandleFunc("/im/internal/emoji_assets/import", app.handleInternalEmojiAssetImport)
	mux.HandleFunc("/im/internal/emoji_assets/upload", app.handleInternalEmojiAssetUpload)
	mux.HandleFunc("/im/assets/emoji/", app.handleEmojiAssetFile)
	mux.HandleFunc("/im/assets/image/", app.handleImageAssetFile)
	mux.HandleFunc("/im/assets/file/", app.handleFileAssetFile)
	mux.HandleFunc("/im/assets/voice/", app.handleVoiceAssetFile)
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
	go a.runExpiredFileAssetCleanupLoop()
	go a.runRecalledTextCleanupLoop()
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
			nickname TEXT NOT NULL DEFAULT '',
			gender TEXT NOT NULL DEFAULT 'unknown',
			avatar_style TEXT NOT NULL DEFAULT 'thumbs',
			avatar_seed TEXT NOT NULL DEFAULT '',
			avatar_url TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_user_avatar_history (
			id BIGSERIAL PRIMARY KEY,
			username TEXT NOT NULL,
			avatar_style TEXT NOT NULL DEFAULT 'thumbs',
			avatar_seed TEXT NOT NULL DEFAULT '',
			avatar_url TEXT NOT NULL DEFAULT '',
			is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_system_config (
			key TEXT PRIMARY KEY,
			value_json TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_file_asset (
			storage_name TEXT PRIMARY KEY,
			original_name TEXT NOT NULL DEFAULT '',
			mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
			file_size BIGINT NOT NULL DEFAULT 0,
			expires_at TIMESTAMP NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		`ALTER TABLE im_conversation_member ADD COLUMN IF NOT EXISTS left_at TIMESTAMP`,
		`ALTER TABLE im_conversation_member ADD COLUMN IF NOT EXISTS pin_type TEXT NOT NULL DEFAULT 'none'`,
		`ALTER TABLE im_conversation_member ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP`,
		`ALTER TABLE im_user_profile ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_user_profile ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'unknown'`,
		`ALTER TABLE im_user_profile ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_user_avatar_history ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_user_avatar_history ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE im_conversation_member DROP CONSTRAINT IF EXISTS im_conversation_member_conversation_id_username_key`,
		`UPDATE im_conversation_member SET pin_type = CASE WHEN is_pinned THEN 'manual' ELSE 'none' END WHERE COALESCE(pin_type, '') = ''`,
		`UPDATE im_conversation_member SET pinned_at = COALESCE(pinned_at, updated_at, created_at, NOW()) WHERE is_pinned = TRUE AND pinned_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_member_username ON im_conversation_member(username)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_conversation_member_active_unique ON im_conversation_member(conversation_id, username) WHERE left_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_conversation_admin_active_unique ON im_conversation_admin(conversation_id, username) WHERE revoked_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_admin_username ON im_conversation_admin(username)`,
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_member_override_username ON im_conversation_member_override(username)`,
		`CREATE INDEX IF NOT EXISTS idx_im_user_avatar_history_username_created_at ON im_user_avatar_history(username, created_at DESC, id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_message_conversation_id ON im_message(conversation_id, seq_no DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_file_asset_expires_at ON im_file_asset(expires_at)`,
		`CREATE TABLE IF NOT EXISTS im_meetings (
			id BIGSERIAL PRIMARY KEY,
			url TEXT NOT NULL,
			short_id TEXT NOT NULL DEFAULT '',
			meeting_code TEXT NOT NULL DEFAULT '',
			subject TEXT NOT NULL,
			begin_time TIMESTAMP,
			end_time TIMESTAMP,
			creator_nickname TEXT NOT NULL DEFAULT '',
			has_password BOOLEAN NOT NULL DEFAULT FALSE,
			meeting_password TEXT NOT NULL DEFAULT '',
			mtoken TEXT NOT NULL DEFAULT '',
			sender_username TEXT NOT NULL,
			sender_display_name TEXT NOT NULL DEFAULT '',
			group_key TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS im_meeting_reads (
			user_username TEXT NOT NULL,
			meeting_id BIGINT NOT NULL REFERENCES im_meetings(id) ON DELETE CASCADE,
			read_at TIMESTAMP NOT NULL DEFAULT NOW(),
			PRIMARY KEY (user_username, meeting_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_im_meetings_created_at ON im_meetings(created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_im_meetings_group_key ON im_meetings(group_key)`,
	}
	statements = append(statements, emojiAssetSchemaStatements()...)
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

func (a *App) fetchBaseDisplayName(ctx context.Context, username string) string {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return ""
	}
	var displayName string
	_ = a.db.QueryRow(ctx, `SELECT COALESCE(NULLIF(real_name, ''), username) FROM user_stats WHERE username = $1`, normalizedUsername).Scan(&displayName)
	if strings.TrimSpace(displayName) == "" {
		return normalizedUsername
	}
	return strings.TrimSpace(displayName)
}

func (a *App) fetchDisplayName(ctx context.Context, username string) string {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return ""
	}
	profile, err := a.loadUserProfileRecord(ctx, normalizedUsername)
	if err == nil {
		nickname := strings.TrimSpace(profile.Nickname)
		if nickname != "" {
			return nickname
		}
	}
	return a.fetchBaseDisplayName(ctx, normalizedUsername)
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

type userProfileRecord struct {
	Username    string
	Nickname    string
	Gender      string
	AvatarStyle string
	AvatarSeed  string
	AvatarURL   string
}

func normalizeProfileGender(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "male", "m", "man", "boy", "男":
		return "male"
	case "female", "f", "woman", "girl", "女":
		return "female"
	default:
		return "unknown"
	}
}

func (a *App) loadUserProfileRecord(ctx context.Context, username string) (userProfileRecord, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	record := userProfileRecord{
		Username:    normalizedUsername,
		Nickname:    "",
		Gender:      "unknown",
		AvatarStyle: defaultAvatarStyle,
		AvatarSeed:  "",
		AvatarURL:   "",
	}
	if normalizedUsername == "" {
		return record, nil
	}
	err := a.db.QueryRow(ctx, `
		SELECT COALESCE(nickname, ''), COALESCE(NULLIF(gender, ''), 'unknown'), COALESCE(NULLIF(avatar_style, ''), $2), COALESCE(avatar_seed, ''), COALESCE(avatar_url, '')
		FROM im_user_profile
		WHERE username = $1`, normalizedUsername, defaultAvatarStyle).Scan(&record.Nickname, &record.Gender, &record.AvatarStyle, &record.AvatarSeed, &record.AvatarURL)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return record, nil
		}
		return record, err
	}
	record.Gender = normalizeProfileGender(record.Gender)
	record.AvatarStyle = normalizeAvatarStyle(record.AvatarStyle)
	record.AvatarSeed = strings.TrimSpace(record.AvatarSeed)
	record.AvatarURL = strings.TrimSpace(record.AvatarURL)
	record.Nickname = strings.TrimSpace(record.Nickname)
	return record, nil
}

func (a *App) loadUserAvatarProfile(ctx context.Context, username string) (string, string, error) {
	record, err := a.loadUserProfileRecord(ctx, username)
	return normalizeAvatarStyle(record.AvatarStyle), strings.TrimSpace(record.AvatarSeed), err
}

func (a *App) getUserAvatarURL(ctx context.Context, username string) string {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return ""
	}
	record, err := a.loadUserProfileRecord(ctx, normalizedUsername)
	if err != nil {
		log.Printf("load user avatar profile failed: username=%s err=%v", normalizedUsername, err)
		record.AvatarStyle = defaultAvatarStyle
		record.AvatarSeed = ""
	}
	if strings.TrimSpace(record.AvatarURL) != "" {
		return strings.TrimSpace(record.AvatarURL)
	}
	return buildDicebearAvatarURL(record.AvatarStyle, buildAvatarSeed(normalizedUsername, record.AvatarSeed))
}

func (a *App) buildUserProfileItem(ctx context.Context, username string) UserProfileItem {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	profile, err := a.loadUserProfileRecord(ctx, normalizedUsername)
	if err != nil {
		log.Printf("build user profile item avatar load failed: username=%s err=%v", normalizedUsername, err)
		profile.AvatarStyle = defaultAvatarStyle
		profile.AvatarSeed = ""
		profile.AvatarURL = ""
		profile.Nickname = ""
		profile.Gender = "unknown"
	}
	identity := a.buildUserIdentityItem(ctx, normalizedUsername)
	avatarURL := strings.TrimSpace(identity.AvatarURL)
	if avatarURL == "" {
		avatarURL = strings.TrimSpace(profile.AvatarURL)
	}
	if avatarURL == "" {
		avatarURL = buildDicebearAvatarURL(profile.AvatarStyle, buildAvatarSeed(normalizedUsername, profile.AvatarSeed))
	}
	return UserProfileItem{
		Username:    normalizedUsername,
		DisplayName: identity.DisplayName,
		HonorName:   identity.HonorName,
		Nickname:    strings.TrimSpace(profile.Nickname),
		Gender:      normalizeProfileGender(profile.Gender),
		AvatarStyle: normalizeAvatarStyle(profile.AvatarStyle),
		AvatarURL:   avatarURL,
	}
}

func (a *App) updateUserProfile(ctx context.Context, username string, nickname string, gender string) (UserProfileItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return UserProfileItem{}, errors.New("invalid username")
	}
	normalizedNickname := strings.TrimSpace(nickname)
	normalizedGender := normalizeProfileGender(gender)
	if _, err := a.db.Exec(ctx, `
		INSERT INTO im_user_profile (username, nickname, gender, avatar_style, avatar_seed, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (username) DO UPDATE
		SET nickname = EXCLUDED.nickname,
			gender = EXCLUDED.gender,
			updated_at = NOW()`, normalizedUsername, normalizedNickname, normalizedGender, defaultAvatarStyle, ""); err != nil {
		return UserProfileItem{}, err
	}
	return a.buildUserProfileItem(ctx, normalizedUsername), nil
}

type avatarHistoryRecord struct {
	ID          int64
	Username    string
	AvatarStyle string
	AvatarSeed  string
	AvatarURL   string
	IsFavorite  bool
	CreatedAt   time.Time
}

func buildUserAvatarHistoryItem(username string, record avatarHistoryRecord) UserAvatarHistoryItem {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	avatarStyle := normalizeAvatarStyle(record.AvatarStyle)
	avatarSeed := strings.TrimSpace(record.AvatarSeed)
	avatarURL := strings.TrimSpace(record.AvatarURL)
	if avatarURL == "" {
		avatarURL = buildDicebearAvatarURL(avatarStyle, buildAvatarSeed(normalizedUsername, avatarSeed))
	}
	return UserAvatarHistoryItem{
		ID:          record.ID,
		AvatarStyle: avatarStyle,
		AvatarURL:   avatarURL,
		IsFavorite:  record.IsFavorite,
		CreatedAt:   record.CreatedAt.Format(time.RFC3339),
	}
}

func (a *App) loadUserAvatarHistoryRecord(ctx context.Context, username string, historyID int64) (avatarHistoryRecord, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	record := avatarHistoryRecord{
		ID:          historyID,
		Username:    normalizedUsername,
		AvatarStyle: defaultAvatarStyle,
		AvatarSeed:  "",
		AvatarURL:   "",
		IsFavorite:  false,
	}
	if normalizedUsername == "" || historyID <= 0 {
		return record, pgx.ErrNoRows
	}
	err := a.db.QueryRow(ctx, `
		SELECT id, COALESCE(NULLIF(avatar_style, ''), $3), COALESCE(avatar_seed, ''), COALESCE(avatar_url, ''), COALESCE(is_favorite, FALSE), created_at
		FROM im_user_avatar_history
		WHERE id = $1 AND username = $2`, historyID, normalizedUsername, defaultAvatarStyle).Scan(&record.ID, &record.AvatarStyle, &record.AvatarSeed, &record.AvatarURL, &record.IsFavorite, &record.CreatedAt)
	if err != nil {
		return record, err
	}
	record.AvatarStyle = normalizeAvatarStyle(record.AvatarStyle)
	record.AvatarSeed = strings.TrimSpace(record.AvatarSeed)
	record.AvatarURL = strings.TrimSpace(record.AvatarURL)
	return record, nil
}

func (a *App) insertUserAvatarHistory(ctx context.Context, tx pgx.Tx, username string, avatarStyle string, avatarSeed string, avatarURL string) (bool, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	normalizedStyle := normalizeAvatarStyle(avatarStyle)
	normalizedSeed := strings.TrimSpace(avatarSeed)
	normalizedURL := strings.TrimSpace(avatarURL)
	if normalizedUsername == "" || (normalizedSeed == "" && normalizedURL == "") {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_user_avatar_history (username, avatar_style, avatar_seed, avatar_url, is_favorite)
		VALUES ($1, $2, $3, $4, FALSE)`, normalizedUsername, normalizedStyle, normalizedSeed, normalizedURL); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		WITH overflow AS (
			SELECT GREATEST(COUNT(1) - $2, 0) AS excess
			FROM im_user_avatar_history
			WHERE username = $1
		)
		DELETE FROM im_user_avatar_history
		WHERE id IN (
			SELECT id
			FROM im_user_avatar_history
			WHERE username = $1 AND COALESCE(is_favorite, FALSE) = FALSE
			ORDER BY created_at ASC, id ASC
			LIMIT (SELECT excess FROM overflow)
		)`, normalizedUsername, 10); err != nil {
		return false, err
	}
	return true, nil
}

func (a *App) listUserAvatarHistory(ctx context.Context, username string, limit int) ([]UserAvatarHistoryItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return []UserAvatarHistoryItem{}, nil
	}
	if limit <= 0 {
		limit = 10
	}
	rows, err := a.db.Query(ctx, `
		SELECT id, COALESCE(NULLIF(avatar_style, ''), $2), COALESCE(avatar_seed, ''), COALESCE(avatar_url, ''), COALESCE(is_favorite, FALSE), created_at
		FROM im_user_avatar_history
		WHERE username = $1
		ORDER BY COALESCE(is_favorite, FALSE) DESC, created_at DESC, id DESC
		LIMIT $3`, normalizedUsername, defaultAvatarStyle, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]UserAvatarHistoryItem, 0)
	for rows.Next() {
		record := avatarHistoryRecord{Username: normalizedUsername}
		if err := rows.Scan(&record.ID, &record.AvatarStyle, &record.AvatarSeed, &record.AvatarURL, &record.IsFavorite, &record.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, buildUserAvatarHistoryItem(normalizedUsername, record))
	}
	return items, rows.Err()
}

func (a *App) refreshUserAvatarProfile(ctx context.Context, username string) (UserProfileItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return UserProfileItem{}, errors.New("invalid username")
	}
	avatarSeed := randomAvatarSeed()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return UserProfileItem{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_user_profile (username, avatar_style, avatar_seed, avatar_url, updated_at)
		VALUES ($1, $2, $3, '', NOW())
		ON CONFLICT (username) DO UPDATE
		SET avatar_style = EXCLUDED.avatar_style,
			avatar_seed = EXCLUDED.avatar_seed,
			avatar_url = '',
			updated_at = NOW()`, normalizedUsername, defaultAvatarStyle, avatarSeed); err != nil {
		return UserProfileItem{}, err
	}
	if _, err := a.insertUserAvatarHistory(ctx, tx, normalizedUsername, defaultAvatarStyle, avatarSeed, ""); err != nil {
		return UserProfileItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserProfileItem{}, err
	}
	return a.buildUserProfileItem(ctx, normalizedUsername), nil
}

func (a *App) selectUserAvatarHistory(ctx context.Context, username string, historyID int64) (UserProfileItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return UserProfileItem{}, errors.New("invalid username")
	}
	if historyID <= 0 {
		return UserProfileItem{}, errors.New("invalid history_id")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return UserProfileItem{}, err
	}
	defer tx.Rollback(ctx)
	var avatarStyle string
	var avatarSeed string
	var avatarURL string
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(avatar_style, ''), $3), COALESCE(avatar_seed, ''), COALESCE(avatar_url, '')
		FROM im_user_avatar_history
		WHERE id = $1 AND username = $2`, historyID, normalizedUsername, defaultAvatarStyle).Scan(&avatarStyle, &avatarSeed, &avatarURL)
	if err != nil {
		return UserProfileItem{}, err
	}
	avatarStyle = normalizeAvatarStyle(avatarStyle)
	avatarSeed = strings.TrimSpace(avatarSeed)
	avatarURL = strings.TrimSpace(avatarURL)
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_user_profile (username, avatar_style, avatar_seed, avatar_url, updated_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (username) DO UPDATE
		SET avatar_style = EXCLUDED.avatar_style,
			avatar_seed = EXCLUDED.avatar_seed,
			avatar_url = EXCLUDED.avatar_url,
			updated_at = NOW()`, normalizedUsername, avatarStyle, avatarSeed, avatarURL); err != nil {
		return UserProfileItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserProfileItem{}, err
	}
	return a.buildUserProfileItem(ctx, normalizedUsername), nil
}

func (a *App) setUserAvatarHistoryFavorite(ctx context.Context, username string, historyID int64, favorite bool) error {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return errors.New("invalid username")
	}
	if historyID <= 0 {
		return errors.New("invalid history_id")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var currentFavorite bool
	err = tx.QueryRow(ctx, `SELECT COALESCE(is_favorite, FALSE) FROM im_user_avatar_history WHERE id = $1 AND username = $2`, historyID, normalizedUsername).Scan(&currentFavorite)
	if err != nil {
		return err
	}
	if favorite && !currentFavorite {
		var favoriteCount int
		if err := tx.QueryRow(ctx, `SELECT COUNT(1) FROM im_user_avatar_history WHERE username = $1 AND COALESCE(is_favorite, FALSE) = TRUE`, normalizedUsername).Scan(&favoriteCount); err != nil {
			return err
		}
		if favoriteCount >= 10 {
			return errors.New("最多只能收藏10个头像")
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE im_user_avatar_history SET is_favorite = $3 WHERE id = $1 AND username = $2`, historyID, normalizedUsername, favorite); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *App) removeUserAvatarHistory(ctx context.Context, username string, historyID int64) error {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if normalizedUsername == "" {
		return errors.New("invalid username")
	}
	if historyID <= 0 {
		return errors.New("invalid history_id")
	}
	commandTag, err := a.db.Exec(ctx, `DELETE FROM im_user_avatar_history WHERE id = $1 AND username = $2`, historyID, normalizedUsername)
	if err != nil {
		return err
	}
	if commandTag.RowsAffected() <= 0 {
		return pgx.ErrNoRows
	}
	return nil
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
			HonorName:   member.HonorName,
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
		HonorName:        profile.HonorName,
		AvatarURL:        profile.AvatarURL,
		EmojiAssets:      a.loadBootstrapEmojiAssets(r.Context()),
		RetentionDays:    180,
		StoreEncoding:    "plain",
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
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"item": a.buildUserProfileItem(r.Context(), username)})
	case http.MethodPost:
		var req profileUpdateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		item, err := a.updateUserProfile(r.Context(), username, req.Nickname, req.Gender)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"item": item})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
	}
}

func (a *App) handleProfileAvatarHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	items, err := a.listUserAvatarHistory(r.Context(), username, 10)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
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

func (a *App) handleProfileAvatarSelect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req avatarHistoryActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	item, err := a.selectUserAvatarHistory(r.Context(), username, req.HistoryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "avatar history not found"})
			return
		}
		if strings.Contains(err.Error(), "invalid history_id") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid history_id"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}

func (a *App) handleProfileAvatarFavorite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req avatarHistoryFavoriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if err := a.setUserAvatarHistoryFavorite(r.Context(), username, req.HistoryID, req.Favorite); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "avatar history not found"})
			return
		}
		if strings.Contains(err.Error(), "invalid history_id") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid history_id"})
			return
		}
		if err.Error() == "最多只能收藏10个头像" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *App) handleProfileAvatarRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	var req avatarHistoryActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
		return
	}
	if err := a.removeUserAvatarHistory(r.Context(), username, req.HistoryID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": true, "message": "avatar history not found"})
			return
		}
		if strings.Contains(err.Error(), "invalid history_id") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid history_id"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
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
		peerIdentity := a.buildUserIdentityItem(r.Context(), item.PeerUsername)
		item.PeerDisplayName = peerIdentity.DisplayName
		item.PeerHonorName = peerIdentity.HonorName
		if item.ConversationType != "group" {
			item.AvatarURL = peerIdentity.AvatarURL
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
	eventType := "im.message.recalled"
	if strings.EqualFold(strings.TrimSpace(item.Status), "deleted") {
		eventType = "im.message.deleted"
	}
	a.broadcastConversation(item.ConversationID, map[string]any{"type": eventType, "payload": item})
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
	if !a.ensureConversationMember(r.Context(), fmt.Sprintf("%d", conversationIDValue), username) {
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
		senderIdentity := a.buildUserIdentityItem(r.Context(), item.SenderUsername)
		item.SenderDisplayName = senderIdentity.DisplayName
		item.SenderHonorName = senderIdentity.HonorName
		item.SenderAvatarURL = senderIdentity.AvatarURL
		item = a.normalizeOutgoingMessageItem(r.Context(), item)
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
	message, err := a.insertMessage(r.Context(), req.ConversationID, username, req)
	if err != nil {
		if errors.Is(err, errInvalidMessageType) || errors.Is(err, errInvalidEmojiAssetID) || errors.Is(err, errInvalidVoicePayload) || errors.Is(err, errInvalidImagePayload) || errors.Is(err, errInvalidFilePayload) || errors.Is(err, errInvalidLocationPayload) || errors.Is(err, errEmptyMessageContent) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(req.ConversationID, map[string]any{
		"type": "im.message.created",
		"payload": message,
	})
	writeJSON(w, http.StatusOK, map[string]any{"item": message})
}

func buildMessageStorage(req sendMessageRequest) (messageType string, contentPreview string, contentPayload string, contentSizeRaw int, contentSizeStored int, err error) {
	messageType = strings.TrimSpace(strings.ToLower(req.MessageType))
	if messageType == "" {
		messageType = "text"
	}
	switch messageType {
	case "text":
		contentPayload = strings.TrimSpace(req.Content)
		if contentPayload == "" {
			err = errEmptyMessageContent
			return
		}
		contentPreview = contentPayload
		contentSizeRaw = len(contentPayload)
		contentSizeStored = len(contentPayload)
	case "emoji_custom":
		if req.EmojiAssetID <= 0 {
			err = errInvalidEmojiAssetID
			return
		}
		contentPreview = strings.TrimSpace(req.Content)
		if contentPreview == "" {
			contentPreview = "[表情]"
		}
		payloadBytes, marshalErr := json.Marshal(map[string]any{
			"emoji_asset_id": req.EmojiAssetID,
			"code":           strings.TrimSpace(req.Content),
		})
		if marshalErr != nil {
			err = marshalErr
			return
		}
		contentPayload = string(payloadBytes)
		contentSizeRaw = len(contentPreview)
		contentSizeStored = len(contentPayload)
	case "voice":
		voicePayload, voiceErr := normalizeVoiceMessagePayload(req.Content)
		if voiceErr != nil {
			err = voiceErr
			return
		}
		payloadBytes, marshalErr := json.Marshal(voicePayload)
		if marshalErr != nil {
			err = marshalErr
			return
		}
		contentPreview = formatVoiceMessagePreview(voicePayload.DurationMs)
		contentPayload = string(payloadBytes)
		contentSizeRaw = voicePayload.FileSize
		contentSizeStored = voicePayload.FileSize
	case "image":
		imagePayload, imageErr := normalizeImageMessagePayload(req.Content)
		if imageErr != nil {
			err = imageErr
			return
		}
		payloadBytes, marshalErr := json.Marshal(imagePayload)
		if marshalErr != nil {
			err = marshalErr
			return
		}
		contentPreview = formatImageMessagePreview()
		contentPayload = string(payloadBytes)
		contentSizeRaw = imagePayload.FileSize
		contentSizeStored = imagePayload.FileSize
	case "file":
		filePayload, fileErr := normalizeStoredFileMessagePayload(req.Content)
		if fileErr != nil {
			err = fileErr
			return
		}
		payloadBytes, marshalErr := json.Marshal(filePayload)
		if marshalErr != nil {
			err = marshalErr
			return
		}
		contentPreview = formatFileMessagePreview(filePayload.FileName)
		contentPayload = string(payloadBytes)
		contentSizeRaw = filePayload.FileSize
		contentSizeStored = filePayload.FileSize
	case "location":
		locationPayload, locationErr := normalizeLocationMessagePayload(req.Content)
		if locationErr != nil {
			err = locationErr
			return
		}
		payloadBytes, marshalErr := json.Marshal(locationPayload)
		if marshalErr != nil {
			err = marshalErr
			return
		}
		contentPreview = formatLocationMessagePreview(locationPayload)
		contentPayload = string(payloadBytes)
		contentSizeRaw = len(contentPayload)
		contentSizeStored = len(contentPayload)
	default:
		err = errInvalidMessageType
		return
	}
	if len([]rune(contentPreview)) > 120 {
		contentPreview = string([]rune(contentPreview)[:120])
	}
	return
}

func (a *App) insertMessage(ctx context.Context, conversationID int64, username string, req sendMessageRequest) (MessageItem, error) {
	messageType, preview, contentPayload, contentSizeRaw, contentSizeStored, err := buildMessageStorage(req)
	if err != nil {
		return MessageItem{}, err
	}
	if messageType == "emoji_custom" {
		exists, existsErr := a.emojiAssetExists(ctx, req.EmojiAssetID)
		if existsErr != nil {
			return MessageItem{}, existsErr
		}
		if !exists {
			return MessageItem{}, errInvalidEmojiAssetID
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return MessageItem{}, err
	}
	defer tx.Rollback(ctx)
	var nextSeqNo int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq_no), 0) + 1 FROM im_message WHERE conversation_id = $1`, conversationID).Scan(&nextSeqNo); err != nil {
		return MessageItem{}, err
	}
	var item MessageItem
	var sentAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO im_message (conversation_id, sender_username, seq_no, message_type, content_preview, content_payload, content_size_raw, content_size_stored)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, conversation_id, sender_username, seq_no, message_type, content_payload, content_preview, status, sent_at`,
		conversationID, username, nextSeqNo, messageType, preview, contentPayload, contentSizeRaw, contentSizeStored,
	).Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt)
	if err != nil {
		return MessageItem{}, err
	}
	item.SentAt = sentAt.Format(time.RFC3339)
	senderIdentity := a.buildUserIdentityItem(ctx, item.SenderUsername)
	item.SenderDisplayName = senderIdentity.DisplayName
	item.SenderHonorName = senderIdentity.HonorName
	item.SenderAvatarURL = senderIdentity.AvatarURL
	item.ClientTempID = strings.TrimSpace(req.ClientTempID)
	item = a.normalizeOutgoingMessageItem(ctx, item)
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
	if time.Since(sentAt) > messageRecallEditableWindow {
		return MessageItem{}, errors.New("message recall expired")
	}
	if item.Status == "recalled" {
		return MessageItem{}, errors.New("message already recalled")
	}
	item.SentAt = sentAt.Format(time.RFC3339)
	senderIdentity := a.buildUserIdentityItem(ctx, item.SenderUsername)
	item.SenderDisplayName = senderIdentity.DisplayName
	item.SenderHonorName = senderIdentity.HonorName
	item.SenderAvatarURL = senderIdentity.AvatarURL
	if strings.EqualFold(strings.TrimSpace(item.MessageType), "text") {
		item.Content = ""
		item.ContentPreview = "[消息已撤回]"
		item.Status = "recalled"
		if _, err := tx.Exec(ctx, `UPDATE im_message SET status = 'recalled', content_preview = $1, content_payload = '', updated_at = NOW() WHERE id = $2`, item.ContentPreview, item.ID); err != nil {
			return MessageItem{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE im_conversation SET last_message_preview = CASE WHEN last_message_id = $1 THEN $2 ELSE last_message_preview END, updated_at = NOW() WHERE id = $3`, item.ID, item.ContentPreview, item.ConversationID); err != nil {
			return MessageItem{}, err
		}
		return item, tx.Commit(ctx)
	}
	plan, err := buildRecallCleanupPlan(item)
	if err != nil {
		log.Printf("im recall cleanup plan parse failed: message_id=%d type=%s err=%v", item.ID, item.MessageType, err)
		plan = recallCleanupPlan{}
	}
	return a.recallDeleteMessage(ctx, tx, item, sentAt, plan)
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
			if payload.ConversationID <= 0 {
				continue
			}
			if !a.ensureConversationMember(r.Context(), fmt.Sprintf("%d", payload.ConversationID), username) {
				continue
			}
			item, err := a.insertMessage(r.Context(), payload.ConversationID, username, payload)
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
