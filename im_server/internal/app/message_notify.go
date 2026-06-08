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
	webhookURL := strings.TrimSpace(cfg.NotifyCenterWebhookURL)
	secret := strings.TrimSpace(cfg.NotifyCenterWebhookSecret)
	timeoutMS := cfg.NotifyCenterTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 1500
	}
	publisher := &MessageNotifyPublisher{
		enabled:    cfg.NotifyCenterEnabled && webhookURL != "" && secret != "",
		webhookURL: webhookURL,
		secret:     secret,
		client:     &http.Client{Timeout: time.Duration(timeoutMS) * time.Millisecond},
		queue:      make(chan []byte, 1024),
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
		log.Printf("im notify center marshal failed: %v", err)
		return
	}
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return
	}
	select {
	case p.queue <- body:
	case <-p.done:
	case <-time.After(500 * time.Millisecond):
		log.Printf("im notify center queue full, dropped")
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
			log.Printf("im notify center publisher close timeout")
		}
	})
}

func (p *MessageNotifyPublisher) run() {
	defer p.wg.Done()
	for {
		select {
		case body := <-p.queue:
			p.postWithRetry(body)
		case <-p.done:
			return
		}
	}
}

func (p *MessageNotifyPublisher) postWithRetry(body []byte) {
	delays := []time.Duration{0, 500 * time.Millisecond, 2 * time.Second}
	for index, delay := range delays {
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-p.done:
				return
			}
		}
		if p.post(body) {
			return
		}
		if index == len(delays)-1 {
			log.Printf("im notify center post abandoned after retries")
		}
	}
}

func (p *MessageNotifyPublisher) post(body []byte) bool {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	nonce := fmt.Sprintf("%d", time.Now().UnixNano())
	signature := p.sign(timestamp, nonce, body)
	req, err := http.NewRequest(http.MethodPost, p.webhookURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("im notify center request build failed: %v", err)
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Notify-Timestamp", timestamp)
	req.Header.Set("X-Notify-Nonce", nonce)
	req.Header.Set("X-Notify-Signature", signature)
	resp, err := p.client.Do(req)
	if err != nil {
		log.Printf("im notify center post failed: %v", err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("im notify center post status=%d", resp.StatusCode)
		return false
	}
	return true
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

func (a *App) broadcastMessageCreated(ctx context.Context, conversationID int64, item MessageItem, memberSnapshots ...[]conversationMemberSnapshot) {
	a.broadcastConversation(conversationID, map[string]any{"type": "im.message.created", "payload": item})
	a.notifyMessageCreated(ctx, item, memberSnapshots...)
}

func (a *App) notifyMessageCreated(ctx context.Context, item MessageItem, memberSnapshots ...[]conversationMemberSnapshot) {
	if a == nil || a.messageNotifier == nil || item.ID <= 0 || item.ConversationID <= 0 {
		return
	}
	meta, err := a.loadConversationMeta(ctx, item.ConversationID)
	if err != nil {
		log.Printf("im notify center load conversation meta failed: conversation_id=%d err=%v", item.ConversationID, err)
		return
	}
	var members []conversationMemberSnapshot
	if len(memberSnapshots) > 0 {
		members = memberSnapshots[0]
	}
	if members == nil {
		var err error
		members, err = a.listConversationMembers(ctx, item.ConversationID)
		if err != nil {
			log.Printf("im notify center load members failed: conversation_id=%d err=%v", item.ConversationID, err)
			return
		}
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
		"event_id":            fmt.Sprintf("im:%d:%d", item.ConversationID, item.ID),
		"event_type":          "im.message.created",
		"message_id":          item.ID,
		"conversation_id":     item.ConversationID,
		"conversation_type":   strings.TrimSpace(meta.ConversationType),
		"conversation_title":  conversationTitle,
		"sender_username":     item.SenderUsername,
		"sender_display_name": item.SenderDisplayName,
		"message_type":        item.MessageType,
		"sent_at":             item.SentAt,
		"recipient_usernames": recipients,
		"mention_usernames":   item.MentionUsernames,
		"mention_all":         item.MentionAll,
	}
	a.messageNotifier.Publish(ctx, event)
}
