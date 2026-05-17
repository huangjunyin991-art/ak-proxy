package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"im_server/internal/config"
)

type MessageNotifyPublisher struct {
	enabled    bool
	webhookURL string
	secret     string
	client     *http.Client
	queue      chan []byte
	done       chan struct{}
	closeOnce  sync.Once
	wg         sync.WaitGroup
	mu         sync.Mutex
	closed     bool
}

func NewMessageNotifyPublisher(cfg config.Config) *MessageNotifyPublisher {
	webhookURL := strings.TrimSpace(cfg.WechatNotifyWebhookURL)
	secret := strings.TrimSpace(cfg.WechatNotifyWebhookSecret)
	timeoutMS := cfg.WechatNotifyTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 1500
	}
	publisher := &MessageNotifyPublisher{
		enabled:    cfg.WechatNotifyEnabled && webhookURL != "" && secret != "",
		webhookURL: webhookURL,
		secret:     secret,
		client:     &http.Client{Timeout: time.Duration(timeoutMS) * time.Millisecond},
		queue:      make(chan []byte, 128),
		done:       make(chan struct{}),
	}
	if publisher.enabled {
		publisher.wg.Add(1)
		go publisher.run()
	}
	return publisher
}

func (p *MessageNotifyPublisher) Publish(ctx context.Context, payload map[string]any) {
	if p == nil || !p.enabled {
		return
	}
	_ = ctx
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("im wechat notify marshal failed: %v", err)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	select {
	case p.queue <- body:
	default:
		log.Printf("im wechat notify queue full, dropped")
	}
}

func (p *MessageNotifyPublisher) Close() {
	if p == nil || !p.enabled {
		return
	}
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		close(p.done)
		p.mu.Unlock()
		finished := make(chan struct{})
		go func() {
			p.wg.Wait()
			close(finished)
		}()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			log.Printf("im wechat notify publisher close timeout")
		}
	})
}

func (p *MessageNotifyPublisher) run() {
	defer p.wg.Done()
	for {
		select {
		case body := <-p.queue:
			p.post(body)
		case <-p.done:
			return
		}
	}
}

func (p *MessageNotifyPublisher) post(body []byte) {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	nonce := fmt.Sprintf("%d", time.Now().UnixNano())
	signature := p.sign(timestamp, nonce, body)
	req, err := http.NewRequest(http.MethodPost, p.webhookURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("im wechat notify request build failed: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Notify-Timestamp", timestamp)
	req.Header.Set("X-Notify-Nonce", nonce)
	req.Header.Set("X-Notify-Signature", signature)
	resp, err := p.client.Do(req)
	if err != nil {
		log.Printf("im wechat notify post failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("im wechat notify post status=%d", resp.StatusCode)
	}
}

func (p *MessageNotifyPublisher) sign(timestamp string, nonce string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(p.secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("\n"))
	mac.Write([]byte(nonce))
	mac.Write([]byte("\n"))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func (a *App) broadcastMessageCreated(ctx context.Context, conversationID int64, item MessageItem) {
	a.broadcastConversation(conversationID, map[string]any{"type": "im.message.created", "payload": item})
	a.notifyMessageCreated(ctx, item)
}

func (a *App) notifyMessageCreated(ctx context.Context, item MessageItem) {
	if a == nil || a.messageNotifier == nil || item.ID <= 0 || item.ConversationID <= 0 {
		return
	}
	meta, err := a.loadConversationMeta(ctx, item.ConversationID)
	if err != nil {
		log.Printf("im wechat notify load conversation meta failed: conversation_id=%d err=%v", item.ConversationID, err)
		return
	}
	members, err := a.listConversationMembers(ctx, item.ConversationID)
	if err != nil {
		log.Printf("im wechat notify load members failed: conversation_id=%d err=%v", item.ConversationID, err)
		return
	}
	sender := strings.ToLower(strings.TrimSpace(item.SenderUsername))
	recipients := make([]string, 0, len(members))
	seen := map[string]struct{}{}
	for _, member := range members {
		if member.LeftAt != nil {
			continue
		}
		username := strings.ToLower(strings.TrimSpace(member.Username))
		if username == "" || username == sender {
			continue
		}
		if _, ok := seen[username]; ok {
			continue
		}
		seen[username] = struct{}{}
		recipients = append(recipients, username)
	}
	if len(recipients) == 0 {
		return
	}
	conversationTitle := strings.TrimSpace(meta.ConversationTitle)
	if strings.EqualFold(meta.ConversationType, "group") && conversationTitle == "" {
		conversationTitle = whitelistMainGroupTitle
	}
	event := map[string]any{
		"event_id":             fmt.Sprintf("im:%d:%d", item.ConversationID, item.ID),
		"event_type":           "im.message.created",
		"message_id":           item.ID,
		"conversation_id":      item.ConversationID,
		"conversation_type":    strings.TrimSpace(meta.ConversationType),
		"conversation_title":   conversationTitle,
		"sender_username":      item.SenderUsername,
		"sender_display_name":  item.SenderDisplayName,
		"message_type":         item.MessageType,
		"sent_at":              item.SentAt,
		"recipient_usernames":  recipients,
		"mention_usernames":    item.MentionUsernames,
		"mention_all":          item.MentionAll,
	}
	a.messageNotifier.Publish(ctx, event)
}
