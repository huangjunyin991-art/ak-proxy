package service

import (
	"testing"
	"time"
)

func TestAdjustableLimiterSetLimitDoesNotInterruptInFlight(t *testing.T) {
	limiter := NewAdjustableLimiter(2)
	releaseOne := limiter.Acquire()
	releaseTwo := limiter.Acquire()
	limiter.SetLimit(1)

	acquired := make(chan func(), 1)
	go func() {
		acquired <- limiter.Acquire()
	}()

	select {
	case release := <-acquired:
		release()
		t.Fatalf("third task acquired while in-flight count was still above the lowered limit")
	case <-time.After(30 * time.Millisecond):
	}

	limit, running, waiting := limiter.Stats()
	if limit != 1 || running != 2 || waiting != 1 {
		t.Fatalf("unexpected limiter stats: limit=%d running=%d waiting=%d", limit, running, waiting)
	}

	releaseOne()
	select {
	case release := <-acquired:
		release()
		t.Fatalf("third task acquired before running count dropped below the lowered limit")
	case <-time.After(30 * time.Millisecond):
	}

	releaseTwo()
	select {
	case release := <-acquired:
		release()
	case <-time.After(time.Second):
		t.Fatalf("third task did not acquire after running count dropped below limit")
	}
}

func TestAdjustableLimiterSetLimitIncreaseWakesWaiter(t *testing.T) {
	limiter := NewAdjustableLimiter(1)
	releaseOne := limiter.Acquire()
	defer releaseOne()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- limiter.Acquire()
	}()

	select {
	case release := <-acquired:
		release()
		t.Fatalf("second task acquired before limit increased")
	case <-time.After(30 * time.Millisecond):
	}

	limiter.SetLimit(2)
	select {
	case release := <-acquired:
		release()
	case <-time.After(time.Second):
		t.Fatalf("second task did not acquire after limit increased")
	}
}
