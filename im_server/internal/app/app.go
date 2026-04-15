package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"im_server/internal/config"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
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
	RetentionDays     int    `json:"retention_days"`
	StoreEncoding     string `json:"store_encoding"`
	CompressMinBytes  int    `json:"compress_min_bytes"`
}

type SessionItem struct {
	ConversationID     int64  `json:"conversation_id"`
	ConversationType   string `json:"conversation_type"`
	PeerUsername       string `json:"peer_username,omitempty"`
	PeerDisplayName    string `json:"peer_display_name,omitempty"`
	LastMessageID      int64  `json:"last_message_id,omitempty"`
	LastMessagePreview string `json:"last_message_preview,omitempty"`
	LastMessageAt      string `json:"last_message_at,omitempty"`
	UnreadCount        int64  `json:"unread_count"`
}

type MessageItem struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	SenderUsername string `json:"sender_username"`
	SeqNo          int64  `json:"seq_no"`
	MessageType    string `json:"message_type"`
	Content        string `json:"content"`
	ContentPreview string `json:"content_preview"`
	Status         string `json:"status"`
	SentAt         string `json:"sent_at"`
	Read           bool   `json:"read"`
}

type sendMessageRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Content        string `json:"content"`
}

type directSessionRequest struct {
	TargetUsername string `json:"target_username"`
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
	mux.HandleFunc("/im/api/sessions", app.handleSessions)
	mux.HandleFunc("/im/api/sessions/direct", app.handleDirectSession)
	mux.HandleFunc("/im/api/messages", app.handleMessages)
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
	log.Printf("im server listen on %s", a.cfg.Addr)
	return a.server.ListenAndServe()
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
		`CREATE TABLE IF NOT EXISTS im_conversation_member (
			id BIGSERIAL PRIMARY KEY,
			conversation_id BIGINT NOT NULL REFERENCES im_conversation(id) ON DELETE CASCADE,
			username TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'member',
			joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
			last_read_seq_no BIGINT NOT NULL DEFAULT 0,
			last_read_at TIMESTAMP,
			mute_until TIMESTAMP,
			is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
			is_archived BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			UNIQUE(conversation_id, username)
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
		`CREATE INDEX IF NOT EXISTS idx_im_conversation_member_username ON im_conversation_member(username)`,
		`CREATE INDEX IF NOT EXISTS idx_im_message_conversation_id ON im_message(conversation_id, seq_no DESC)`,
	}
	for _, stmt := range statements {
		if _, err := a.db.Exec(ctx, stmt); err != nil {
			return err
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

func (a *App) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, BootstrapResponse{Enabled: true, Allowed: false})
		return
	}
	writeJSON(w, http.StatusOK, BootstrapResponse{
		Enabled:          true,
		Allowed:          true,
		Username:         username,
		DisplayName:      a.fetchDisplayName(r.Context(), username),
		RetentionDays:    30,
		StoreEncoding:    "plain_or_zstd",
		CompressMinBytes: a.cfg.CompressMinBytes,
	})
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
		SELECT c.id, c.conversation_type, COALESCE(c.last_message_id, 0) AS last_message_id, COALESCE(c.last_message_preview, '') AS last_message_preview, c.last_message_at,
			COALESCE((SELECT COUNT(1) FROM im_message m2 WHERE m2.conversation_id = c.id AND m2.deleted_at IS NULL AND m2.sender_username <> $1 AND m2.seq_no > COALESCE(cm.last_read_seq_no, 0)), 0) AS unread_count,
			COALESCE((SELECT peer.username FROM im_conversation_member peer WHERE peer.conversation_id = c.id AND peer.username <> $1 ORDER BY peer.username LIMIT 1), '') AS peer_username
		FROM im_conversation c
		JOIN im_conversation_member cm ON cm.conversation_id = c.id AND cm.username = $1
		WHERE c.deleted_at IS NULL
		ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`, username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer rows.Close()
	items := make([]SessionItem, 0)
	for rows.Next() {
		var item SessionItem
		var lastMessageAt *time.Time
		if err := rows.Scan(&item.ConversationID, &item.ConversationType, &item.LastMessageID, &item.LastMessagePreview, &lastMessageAt, &item.UnreadCount, &item.PeerUsername); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		item.PeerDisplayName = a.fetchDisplayName(r.Context(), item.PeerUsername)
		if lastMessageAt != nil {
			item.LastMessageAt = lastMessageAt.Format(time.RFC3339)
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
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
	if err == nil {
		return conversationID, tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO im_conversation (conversation_type, conversation_key, owner_username) VALUES ('direct', $1, $2) ON CONFLICT (conversation_key) DO NOTHING`, key, username); err != nil {
		return 0, err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM im_conversation WHERE conversation_key = $1`, key).Scan(&conversationID); err != nil {
		return 0, err
	}
	for _, member := range users {
		if _, err := tx.Exec(ctx, `INSERT INTO im_conversation_member (conversation_id, username) VALUES ($1, $2) ON CONFLICT (conversation_id, username) DO NOTHING`, conversationID, member); err != nil {
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

func (a *App) handleListMessages(w http.ResponseWriter, r *http.Request, username string) {
	conversationID := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
	if conversationID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing conversation_id"})
		return
	}
	if !a.ensureConversationMember(r.Context(), conversationID, username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT m.id, m.conversation_id, m.sender_username, m.seq_no, m.message_type, m.content_payload, m.content_preview, m.status, m.sent_at,
			COALESCE((SELECT cm.last_read_seq_no FROM im_conversation_member cm WHERE cm.conversation_id = m.conversation_id AND cm.username <> $2 ORDER BY cm.username LIMIT 1), 0) AS peer_last_read_seq_no
		FROM im_message m
		WHERE m.conversation_id = $1::bigint AND m.deleted_at IS NULL
		ORDER BY m.seq_no DESC LIMIT 50`, conversationID, username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer rows.Close()
	items := make([]MessageItem, 0)
	for rows.Next() {
		var item MessageItem
		var sentAt time.Time
		var peerLastReadSeqNo int64
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.SenderUsername, &item.SeqNo, &item.MessageType, &item.Content, &item.ContentPreview, &item.Status, &sentAt, &peerLastReadSeqNo); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		item.SentAt = sentAt.Format(time.RFC3339)
		item.Read = item.SenderUsername == username && item.SeqNo <= peerLastReadSeqNo
		items = append(items, item)
	}
	for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
		items[left], items[right] = items[right], items[left]
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
	if _, err := tx.Exec(ctx, `UPDATE im_conversation SET last_message_id = $1, last_message_preview = $2, last_message_at = NOW(), updated_at = NOW() WHERE id = $3`, item.ID, item.ContentPreview, conversationID); err != nil {
		return MessageItem{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE im_conversation_member SET last_read_seq_no = GREATEST(last_read_seq_no, $1), last_read_at = NOW(), updated_at = NOW() WHERE conversation_id = $2 AND username = $3`, item.SeqNo, conversationID, username); err != nil {
		return MessageItem{}, err
	}
	return item, tx.Commit(ctx)
}

func (a *App) ensureConversationMember(ctx context.Context, conversationID string, username string) bool {
	var exists bool
	_ = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM im_conversation_member WHERE conversation_id = $1::bigint AND username = $2)`, conversationID, username).Scan(&exists)
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
	rows, err := a.db.Query(ctx, `SELECT username FROM im_conversation_member WHERE conversation_id = $1`, conversationID)
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
