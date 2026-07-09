package accountidentity

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Identity struct {
	AccountID         int64
	CanonicalUsername string
	MatchedUsername   string
	IsCanonicalMatch  bool
	Usernames         []string
}

type Service struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

func NormalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func (s *Service) EnsureSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return nil
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS account_identities (
			account_id BIGSERIAL PRIMARY KEY,
			canonical_username TEXT NOT NULL UNIQUE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
			last_renamed_at TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS account_username_aliases (
			username TEXT PRIMARY KEY,
			account_id BIGINT NOT NULL REFERENCES account_identities(account_id) ON DELETE CASCADE,
			is_canonical BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_account_username_aliases_account_id ON account_username_aliases(account_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_username_aliases_account_canonical ON account_username_aliases(account_id) WHERE is_canonical = TRUE`,
	}
	for index, stmt := range statements {
		if _, err := s.db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("account identity schema statement #%d failed: %w", index+1, err)
		}
	}
	return nil
}

func (s *Service) Ensure(ctx context.Context, username string) (Identity, error) {
	return s.Resolve(ctx, username, true)
}

func (s *Service) Resolve(ctx context.Context, username string, autoCreate bool) (Identity, error) {
	normalized := NormalizeUsername(username)
	if normalized == "" {
		return Identity{}, errors.New("missing username")
	}
	if s == nil || s.db == nil {
		return Identity{
			CanonicalUsername: normalized,
			MatchedUsername:   normalized,
			IsCanonicalMatch:  true,
			Usernames:         []string{normalized},
		}, nil
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Identity{}, err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()
	identity, err := s.lookupIdentityTx(ctx, tx, normalized)
	if err == nil {
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return Identity{}, commitErr
		}
		return identity, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, err
	}
	if !autoCreate {
		return Identity{}, pgx.ErrNoRows
	}
	var accountID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO account_identities (canonical_username, created_at, updated_at)
		VALUES ($1, NOW(), NOW())
		ON CONFLICT (canonical_username) DO UPDATE
		SET updated_at = account_identities.updated_at
		RETURNING account_id
	`, normalized).Scan(&accountID); err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_username_aliases (username, account_id, is_canonical, created_at, updated_at)
		VALUES ($1, $2, TRUE, NOW(), NOW())
		ON CONFLICT (username) DO NOTHING
	`, normalized, accountID); err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE account_username_aliases
		SET is_canonical = CASE WHEN username = $2 THEN TRUE ELSE FALSE END
		WHERE account_id = $1
	`, accountID, normalized); err != nil {
		return Identity{}, err
	}
	identity, err = s.lookupIdentityTx(ctx, tx, normalized)
	if err != nil {
		return Identity{}, err
	}
	if commitErr := tx.Commit(ctx); commitErr != nil {
		return Identity{}, commitErr
	}
	return identity, nil
}

func (s *Service) lookupIdentityTx(ctx context.Context, tx pgx.Tx, username string) (Identity, error) {
	var identity Identity
	err := tx.QueryRow(ctx, `
		SELECT a.account_id,
		       COALESCE(i.canonical_username, '') AS canonical_username,
		       COALESCE(a.username, '') AS matched_username,
		       COALESCE(a.is_canonical, FALSE) AS is_canonical
		FROM account_username_aliases a
		JOIN account_identities i ON i.account_id = a.account_id
		WHERE a.username = $1
	`, username).Scan(&identity.AccountID, &identity.CanonicalUsername, &identity.MatchedUsername, &identity.IsCanonicalMatch)
	if err != nil {
		return Identity{}, err
	}
	usernames, err := s.listUsernamesTx(ctx, tx, identity.AccountID)
	if err != nil {
		return Identity{}, err
	}
	identity.CanonicalUsername = NormalizeUsername(identity.CanonicalUsername)
	identity.MatchedUsername = NormalizeUsername(identity.MatchedUsername)
	identity.Usernames = usernames
	return identity, nil
}

func (s *Service) listUsernamesTx(ctx context.Context, tx pgx.Tx, accountID int64) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT username
		FROM account_username_aliases
		WHERE account_id = $1
		ORDER BY is_canonical DESC, updated_at DESC, username ASC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		normalized := NormalizeUsername(username)
		if normalized == "" {
			continue
		}
		result = append(result, normalized)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return []string{}, nil
	}
	return result, nil
}
