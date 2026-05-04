package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"im_server/internal/config"
	"im_server/internal/media"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	worker, err := media.NewWorker(ctx, media.Config{
		DatabaseURL:     cfg.DatabaseURL,
		ImageStoreDir:   cfg.ImageStoreDir,
		ScanInterval:    loadDurationSeconds("IM_MEDIA_WORKER_SCAN_SECONDS", 5*time.Second),
		BatchSize:       loadInt("IM_MEDIA_WORKER_BATCH_SIZE", 8),
		PreviewLongEdge: loadInt("IM_MEDIA_PREVIEW_LONG_EDGE", 1920),
	})
	if err != nil {
		log.Fatalf("create media worker failed: %v", err)
	}
	defer worker.Close()
	log.Printf("im media worker started")
	if err := worker.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("run media worker failed: %v", err)
	}
}

func loadInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func loadDurationSeconds(key string, fallback time.Duration) time.Duration {
	seconds := loadInt(key, 0)
	if seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}
