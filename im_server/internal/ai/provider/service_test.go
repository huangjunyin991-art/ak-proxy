package provider

import (
	"context"
	"errors"
	"testing"
)

func TestClassifyProviderFailureRetryableStatus(t *testing.T) {
	err := errors.New("AI provider chat failed (model=DeepSeek): provider status=429: quota exceeded")
	if got := classifyProviderFailure(context.Background(), err); got != providerFailureRetryable {
		t.Fatalf("expected retryable, got %v", got)
	}
	if !shouldCooldownProvider(context.Background(), err) {
		t.Fatalf("expected retryable provider error to trigger cooldown")
	}
	if !shouldTryNextProvider(context.Background(), err) {
		t.Fatalf("expected retryable provider error to try next provider")
	}
}

func TestClassifyProviderFailurePermanentStatus(t *testing.T) {
	for _, err := range []error{
		errors.New("AI provider chat failed (model=gpt-x): provider status=401: unauthorized"),
		errors.New("AI provider chat failed (model=gpt-x): provider status=403: forbidden"),
		errors.New("AI provider chat failed (model=gpt-x): provider status=404: model not found"),
		errors.New("AI chat model is not configured"),
	} {
		if got := classifyProviderFailure(context.Background(), err); got != providerFailurePermanent {
			t.Fatalf("expected permanent for %q, got %v", err.Error(), got)
		}
		if shouldCooldownProvider(context.Background(), err) {
			t.Fatalf("did not expect permanent error to trigger cooldown: %q", err.Error())
		}
		if shouldTryNextProvider(context.Background(), err) {
			t.Fatalf("did not expect permanent error to try next provider: %q", err.Error())
		}
	}
}

func TestClassifyProviderFailureContextDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := context.Canceled
	if got := classifyProviderFailure(ctx, err); got != providerFailureContextDone {
		t.Fatalf("expected context done, got %v", got)
	}
	if shouldCooldownProvider(ctx, err) {
		t.Fatalf("did not expect context cancellation to trigger cooldown")
	}
	if shouldTryNextProvider(ctx, err) {
		t.Fatalf("did not expect context cancellation to try next provider")
	}
}

func TestProviderErrorHTTPStatus(t *testing.T) {
	status, ok := providerErrorHTTPStatus(errors.New("prefix provider status=503: unavailable"))
	if !ok || status != 503 {
		t.Fatalf("expected status 503, got status=%d ok=%v", status, ok)
	}
	if _, ok := providerErrorHTTPStatus(errors.New("provider status=abc")); ok {
		t.Fatalf("did not expect invalid status to parse")
	}
}
