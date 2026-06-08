package ws_ticket

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Claims struct {
	Audience     string         `json:"audience"`
	Subject      string         `json:"subject"`
	Role         string         `json:"role"`
	ResourceType string         `json:"resource_type"`
	ResourceID   string         `json:"resource_id"`
	Site         string         `json:"site"`
	Readonly     bool           `json:"readonly"`
	Extra        map[string]any `json:"claims"`
	ExpiresAt    time.Time      `json:"expires_at"`
}

type IssueRequest struct {
	Audience     string
	Subject      string
	Role         string
	ResourceType string
	ResourceID   string
	Site         string
	Readonly     bool
	Extra        map[string]any
	ClientIP     string
	UserAgent    string
}

type IssueResult struct {
	Ticket    string
	TokenHash string
	Claims    Claims
	ExpiresIn int
}

type Service struct {
	db          *pgxpool.Pool
	ttl         time.Duration
	now         func() time.Time
	tokenSize   int
	diagnostics *DiagnosticsPolicyCache
}

func New(db *pgxpool.Pool, ttlSeconds int) *Service {
	if ttlSeconds < 10 {
		ttlSeconds = 45
	}
	if ttlSeconds > 300 {
		ttlSeconds = 300
	}
	return &Service{
		db:          db,
		ttl:         time.Duration(ttlSeconds) * time.Second,
		now:         time.Now,
		tokenSize:   32,
		diagnostics: NewDiagnosticsPolicyCache(db, 5*time.Second),
	}
}

func (s *Service) Issue(ctx context.Context, req IssueRequest) (IssueResult, error) {
	if s == nil || s.db == nil {
		return IssueResult{}, errors.New("ws ticket service unavailable")
	}
	audience := normalizeRequired(req.Audience)
	subject := normalizeRequired(req.Subject)
	if audience == "" || subject == "" {
		return IssueResult{}, errors.New("missing audience or subject")
	}
	token, err := randomToken(s.tokenSize)
	if err != nil {
		return IssueResult{}, err
	}
	tokenHash := HashToken(token)
	now := s.now().Truncate(time.Second)
	expiresAt := now.Add(s.ttl)
	extra := req.Extra
	if extra == nil {
		extra = map[string]any{}
	}
	extraJSON, err := json.Marshal(extra)
	if err != nil {
		extraJSON = []byte("{}")
	}
	claims := Claims{
		Audience:     audience,
		Subject:      subject,
		Role:         strings.ToLower(strings.TrimSpace(req.Role)),
		ResourceType: strings.TrimSpace(req.ResourceType),
		ResourceID:   strings.TrimSpace(req.ResourceID),
		Site:         strings.TrimSpace(req.Site),
		Readonly:     req.Readonly,
		Extra:        extra,
		ExpiresAt:    expiresAt,
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO ws_tickets (
			token_hash, audience, subject, role, resource_type, resource_id,
			site, readonly, claims, issued_at, expires_at, client_ip, user_agent
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
	`, tokenHash, claims.Audience, claims.Subject, claims.Role, claims.ResourceType, claims.ResourceID,
		claims.Site, claims.Readonly, string(extraJSON), now, expiresAt, trimForStorage(req.ClientIP, 120), trimForStorage(req.UserAgent, 300))
	if err != nil {
		return IssueResult{}, err
	}
	s.recordEvent(ctx, "issue", "ok", claims, req.ClientIP, req.UserAgent)
	return IssueResult{
		Ticket:    token,
		TokenHash: tokenHash,
		Claims:    claims,
		ExpiresIn: int(s.ttl.Seconds()),
	}, nil
}

func (s *Service) Consume(ctx context.Context, ticket string, audience string, clientIP string, userAgent string) (Claims, error) {
	if s == nil || s.db == nil {
		return Claims{}, errors.New("ws ticket service unavailable")
	}
	normalizedTicket := strings.TrimSpace(ticket)
	normalizedAudience := normalizeRequired(audience)
	if normalizedTicket == "" || normalizedAudience == "" {
		s.recordReject(ctx, normalizedAudience, "missing_ticket", clientIP, userAgent)
		return Claims{}, errors.New("missing websocket ticket")
	}
	now := s.now().Truncate(time.Second)
	_, _ = s.db.Exec(ctx, `DELETE FROM ws_tickets WHERE expires_at < $1`, now.Add(-time.Hour))
	var claims Claims
	var extraJSON []byte
	err := s.db.QueryRow(ctx, `
		UPDATE ws_tickets
		SET consumed_at = $2,
		    consume_ip = $3,
		    consume_user_agent = $4
		WHERE token_hash = $1
		  AND audience = $5
		  AND consumed_at IS NULL
		  AND expires_at > $2
		RETURNING audience, subject, role, resource_type, resource_id, site, readonly, claims, expires_at
	`, HashToken(normalizedTicket), now, trimForStorage(clientIP, 120), trimForStorage(userAgent, 300), normalizedAudience).Scan(
		&claims.Audience,
		&claims.Subject,
		&claims.Role,
		&claims.ResourceType,
		&claims.ResourceID,
		&claims.Site,
		&claims.Readonly,
		&extraJSON,
		&claims.ExpiresAt,
	)
	if err != nil {
		s.recordReject(ctx, normalizedAudience, "invalid_ticket", clientIP, userAgent)
		return Claims{}, fmt.Errorf("invalid websocket ticket: %w", err)
	}
	if len(extraJSON) > 0 {
		_ = json.Unmarshal(extraJSON, &claims.Extra)
	}
	if claims.Extra == nil {
		claims.Extra = map[string]any{}
	}
	claims.Audience = strings.TrimSpace(claims.Audience)
	claims.Subject = strings.ToLower(strings.TrimSpace(claims.Subject))
	claims.Role = strings.ToLower(strings.TrimSpace(claims.Role))
	s.recordEvent(ctx, "consume", "ok", claims, clientIP, userAgent)
	return claims, nil
}

func (s *Service) recordReject(ctx context.Context, audience string, code string, clientIP string, userAgent string) {
	s.recordEvent(ctx, "reject", code, Claims{Audience: strings.TrimSpace(audience)}, clientIP, userAgent)
}

func (s *Service) recordEvent(ctx context.Context, eventType string, code string, claims Claims, clientIP string, userAgent string) {
	if s == nil || s.db == nil {
		return
	}
	if s.diagnostics == nil || !s.diagnostics.Enabled(ctx) {
		return
	}
	_, _ = s.db.Exec(ctx, `
		INSERT INTO ws_ticket_events (
			event_type, code, audience, subject, role, resource_type,
			resource_id, site, client_ip, user_agent, created_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`,
		trimForStorage(eventType, 40),
		trimForStorage(code, 80),
		trimForStorage(claims.Audience, 40),
		trimForStorage(claims.Subject, 120),
		trimForStorage(claims.Role, 40),
		trimForStorage(claims.ResourceType, 80),
		trimForStorage(claims.ResourceID, 160),
		trimForStorage(claims.Site, 80),
		trimForStorage(clientIP, 120),
		trimForStorage(userAgent, 300),
		s.now().Truncate(time.Second),
	)
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}

func randomToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func normalizeRequired(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func trimForStorage(value string, limit int) string {
	normalized := strings.TrimSpace(value)
	if limit > 0 && len(normalized) > limit {
		return normalized[:limit]
	}
	return normalized
}
