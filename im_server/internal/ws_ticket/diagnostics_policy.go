package ws_ticket

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const diagnosticsPolicyKey = "ws_ticket_diagnostics_policy"

type DiagnosticsPolicyCache struct {
	db       *pgxpool.Pool
	ttl      time.Duration
	now      func() time.Time
	mu       sync.Mutex
	cached   diagnosticsPolicy
	loadedAt time.Time
}

type diagnosticsPolicy struct {
	Enabled          bool   `json:"enabled"`
	EffectiveEnabled bool   `json:"effective_enabled"`
	Expired          bool   `json:"expired"`
	EnabledUntil     string `json:"enabled_until"`
	RetentionDays    int    `json:"retention_days"`
}

type diagnosticsPolicyPayload struct {
	Enabled       bool   `json:"enabled"`
	EnabledUntil  string `json:"enabled_until"`
	RetentionDays int    `json:"retention_days"`
}

func NewDiagnosticsPolicyCache(db *pgxpool.Pool, ttl time.Duration) *DiagnosticsPolicyCache {
	if ttl <= 0 {
		ttl = 5 * time.Second
	}
	return &DiagnosticsPolicyCache{
		db:  db,
		ttl: ttl,
		now: time.Now,
	}
}

func (c *DiagnosticsPolicyCache) Enabled(ctx context.Context) bool {
	if c == nil || c.db == nil {
		return false
	}
	return c.get(ctx).EffectiveEnabled
}

func (c *DiagnosticsPolicyCache) get(ctx context.Context) diagnosticsPolicy {
	now := c.now()
	c.mu.Lock()
	if !c.loadedAt.IsZero() && now.Sub(c.loadedAt) < c.ttl {
		policy := c.cached
		c.mu.Unlock()
		return policy
	}
	c.mu.Unlock()

	policy := c.load(ctx, now)

	c.mu.Lock()
	c.cached = policy
	c.loadedAt = now
	c.mu.Unlock()
	return policy
}

func (c *DiagnosticsPolicyCache) load(ctx context.Context, now time.Time) diagnosticsPolicy {
	var value string
	err := c.db.QueryRow(ctx, `SELECT value::text FROM system_config WHERE key = $1`, diagnosticsPolicyKey).Scan(&value)
	if err != nil {
		if err == pgx.ErrNoRows {
			return normalizeDiagnosticsPolicy(diagnosticsPolicyPayload{}, now)
		}
		return normalizeDiagnosticsPolicy(diagnosticsPolicyPayload{}, now)
	}
	var payload diagnosticsPolicyPayload
	if err := json.Unmarshal([]byte(value), &payload); err != nil {
		return normalizeDiagnosticsPolicy(diagnosticsPolicyPayload{}, now)
	}
	return normalizeDiagnosticsPolicy(payload, now)
}

func normalizeDiagnosticsPolicy(payload diagnosticsPolicyPayload, now time.Time) diagnosticsPolicy {
	retentionDays := payload.RetentionDays
	if retentionDays < 1 {
		retentionDays = 3
	}
	if retentionDays > 30 {
		retentionDays = 30
	}
	enabledUntil := strings.TrimSpace(payload.EnabledUntil)
	expired := payload.Enabled && enabledUntil == ""
	if payload.Enabled && enabledUntil != "" {
		if deadline, err := time.Parse(time.RFC3339, enabledUntil); err != nil || !deadline.After(now) {
			expired = true
		}
	}
	return diagnosticsPolicy{
		Enabled:          payload.Enabled,
		EffectiveEnabled: payload.Enabled && !expired,
		Expired:          expired,
		EnabledUntil:     enabledUntil,
		RetentionDays:    retentionDays,
	}
}
