package app

import (
	"context"
	"log"
	"strings"

	"im_server/internal/accountidentity"
)

func (a *App) resolveAccountIdentity(ctx context.Context, username string, autoCreate bool) (accountidentity.Identity, error) {
	normalized := accountidentity.NormalizeUsername(username)
	if normalized == "" {
		return accountidentity.Identity{}, nil
	}
	if a == nil || a.accountIdentity == nil {
		return accountidentity.Identity{
			CanonicalUsername: normalized,
			MatchedUsername:   normalized,
			IsCanonicalMatch:  true,
			Usernames:         []string{normalized},
		}, nil
	}
	return a.accountIdentity.Resolve(ctx, normalized, autoCreate)
}

func (a *App) identityLookupUsernames(ctx context.Context, username string, autoCreate bool) (string, []string) {
	normalized := accountidentity.NormalizeUsername(username)
	if normalized == "" {
		return "", []string{}
	}
	identity, err := a.resolveAccountIdentity(ctx, normalized, autoCreate)
	if err != nil {
		log.Printf("resolve account identity failed: username=%s err=%v", normalized, err)
		return normalized, []string{normalized}
	}
	canonical := strings.TrimSpace(identity.CanonicalUsername)
	if canonical == "" {
		canonical = normalized
	}
	usernames := normalizeUsernames(identity.Usernames)
	if len(usernames) == 0 {
		usernames = []string{canonical}
	}
	return canonical, usernames
}

func (a *App) listIdentityUsernames(ctx context.Context, username string) []string {
	_, usernames := a.identityLookupUsernames(ctx, username, true)
	return usernames
}

func identityUsernameSet(usernames []string) map[string]struct{} {
	result := make(map[string]struct{}, len(usernames))
	for _, username := range usernames {
		normalized := accountidentity.NormalizeUsername(username)
		if normalized == "" {
			continue
		}
		result[normalized] = struct{}{}
	}
	return result
}

func identityHasUsername(usernames []string, username string) bool {
	normalized := accountidentity.NormalizeUsername(username)
	if normalized == "" {
		return false
	}
	_, ok := identityUsernameSet(usernames)[normalized]
	return ok
}
