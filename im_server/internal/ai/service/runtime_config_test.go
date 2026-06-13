package service

import (
	"testing"
	"time"
)

func TestDefaultRuntimeConfigEnablesModelReplySuggestions(t *testing.T) {
	cfg := defaultRuntimeConfig()
	if !cfg.ReplySuggestionsEnabled {
		t.Fatalf("reply suggestions should be enabled by default")
	}
	if cfg.ReplySuggestionsMode != replySuggestionsModeModel {
		t.Fatalf("reply suggestions mode = %q, want %q", cfg.ReplySuggestionsMode, replySuggestionsModeModel)
	}
	if cfg.ReplySuggestionsWhenBusy {
		t.Fatalf("reply suggestions should degrade when queue has waiters by default")
	}
}

func TestNormalizeRuntimeConfigReplySuggestionMode(t *testing.T) {
	cfg := normalizeRuntimeConfig(RuntimeConfig{
		ReplySuggestionsEnabled: true,
		ReplySuggestionsMode:    "bad-mode",
	})
	if cfg.ReplySuggestionsMode != replySuggestionsModeModel {
		t.Fatalf("invalid reply suggestion mode should fallback to model, got %q", cfg.ReplySuggestionsMode)
	}

	cfg = normalizeRuntimeConfig(RuntimeConfig{
		ReplySuggestionsEnabled: true,
		ReplySuggestionsMode:    "DEFAULT",
	})
	if cfg.ReplySuggestionsMode != replySuggestionsModeDefault {
		t.Fatalf("reply suggestion mode should normalize to default, got %q", cfg.ReplySuggestionsMode)
	}
}

func TestReplySuggestionsUseDefaultWhenQueueIsWaiting(t *testing.T) {
	s := &Service{limiter: NewAdjustableLimiter(1)}
	releaseFirst := s.limiter.Acquire()
	defer releaseFirst()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- s.limiter.Acquire()
	}()

	select {
	case release := <-acquired:
		release()
		t.Fatalf("second task acquired before first task released")
	case <-time.After(30 * time.Millisecond):
	}

	cfg := defaultRuntimeConfig()
	cfg.ReplySuggestionsMode = replySuggestionsModeModel
	cfg.ReplySuggestionsWhenBusy = false
	if !s.shouldUseDefaultReplySuggestions(cfg) {
		t.Fatalf("expected reply suggestions to degrade to local defaults while queue has waiters")
	}

	cfg.ReplySuggestionsWhenBusy = true
	if s.shouldUseDefaultReplySuggestions(cfg) {
		t.Fatalf("expected reply suggestions to keep model generation when busy generation is allowed")
	}

	releaseFirst()
	select {
	case release := <-acquired:
		release()
	case <-time.After(time.Second):
		t.Fatalf("waiting task did not finish")
	}
}
