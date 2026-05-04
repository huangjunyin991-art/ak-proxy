package media

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultScanInterval = 5 * time.Second
	defaultBatchSize    = 8
	defaultPreviewEdge  = 1920
)

type Worker struct {
	db             *pgxpool.Pool
	imageStoreDir  string
	scanInterval   time.Duration
	batchSize      int
	previewLongEdge int
}

type Config struct {
	DatabaseURL     string
	ImageStoreDir   string
	ScanInterval    time.Duration
	BatchSize       int
	PreviewLongEdge int
}

type imageTask struct {
	MessageID      int64
	ConversationID int64
	Payload        imagePayload
}

type imagePayload struct {
	StorageName         string `json:"storage_name"`
	FileURL             string `json:"file_url,omitempty"`
	FileName            string `json:"file_name,omitempty"`
	MimeType            string `json:"mime_type"`
	FileSize            int    `json:"file_size"`
	Source              string `json:"source,omitempty"`
	OriginalStorageName string `json:"original_storage_name,omitempty"`
	OriginalURL         string `json:"original_url,omitempty"`
	PreviewStorageName  string `json:"preview_storage_name,omitempty"`
	PreviewURL          string `json:"preview_url,omitempty"`
	PreviewStatus       string `json:"preview_status,omitempty"`
}

func NewWorker(ctx context.Context, cfg Config) (*Worker, error) {
	pool, err := pgxpool.New(ctx, strings.TrimSpace(cfg.DatabaseURL))
	if err != nil {
		return nil, err
	}
	worker := &Worker{
		db:              pool,
		imageStoreDir:   strings.TrimSpace(cfg.ImageStoreDir),
		scanInterval:    cfg.ScanInterval,
		batchSize:       cfg.BatchSize,
		previewLongEdge: cfg.PreviewLongEdge,
	}
	if worker.scanInterval <= 0 {
		worker.scanInterval = defaultScanInterval
	}
	if worker.batchSize <= 0 {
		worker.batchSize = defaultBatchSize
	}
	if worker.previewLongEdge <= 0 {
		worker.previewLongEdge = defaultPreviewEdge
	}
	if worker.imageStoreDir == "" {
		worker.imageStoreDir = "./data/im/image_assets"
	}
	return worker, nil
}

func (w *Worker) Close() {
	if w != nil && w.db != nil {
		w.db.Close()
	}
}

func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.db == nil {
		return errors.New("media worker not initialized")
	}
	if _, err := findVipsCommand(); err != nil {
		return err
	}
	if err := os.MkdirAll(w.imageStoreDir, 0o755); err != nil {
		return err
	}
	if err := w.processOnce(ctx); err != nil {
		log.Printf("media worker process failed: %v", err)
	}
	ticker := time.NewTicker(w.scanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := w.processOnce(ctx); err != nil {
				log.Printf("media worker process failed: %v", err)
			}
		}
	}
}

func (w *Worker) processOnce(ctx context.Context) error {
	tasks, err := w.loadPendingTasks(ctx)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if err := w.processTask(ctx, task); err != nil {
			log.Printf("media worker task failed: message_id=%d err=%v", task.MessageID, err)
			_ = w.markTaskFailed(ctx, task)
		}
	}
	return nil
}

func (w *Worker) loadPendingTasks(ctx context.Context) ([]imageTask, error) {
	rows, err := w.db.Query(ctx, `
		SELECT id, conversation_id, content_payload
		FROM im_message
		WHERE message_type = 'image'
			AND status = 'normal'
			AND deleted_at IS NULL
			AND content_payload::jsonb ->> 'preview_status' = 'pending'
			AND content_payload::jsonb ->> 'mime_type' IN ('image/heic', 'image/heif')
		ORDER BY id ASC
		LIMIT $1`, w.batchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]imageTask, 0, w.batchSize)
	for rows.Next() {
		var task imageTask
		var rawPayload string
		if err := rows.Scan(&task.MessageID, &task.ConversationID, &rawPayload); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(rawPayload)), &task.Payload); err != nil {
			continue
		}
		if normalizePreviewStatus(task.Payload.PreviewStatus) != "pending" || !isHEICMimeType(task.Payload.MimeType) {
			continue
		}
		if !ensureImageStorageName(task.Payload.StorageName) {
			continue
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (w *Worker) processTask(ctx context.Context, task imageTask) error {
	sourceName := strings.TrimSpace(task.Payload.OriginalStorageName)
	if sourceName == "" {
		sourceName = strings.TrimSpace(task.Payload.StorageName)
	}
	if !ensureImageStorageName(sourceName) {
		return errors.New("invalid source image storage name")
	}
	sourcePath := filepath.Join(w.imageStoreDir, sourceName)
	if _, err := os.Stat(sourcePath); err != nil {
		return err
	}
	previewName, err := generateStorageName(".jpg")
	if err != nil {
		return err
	}
	previewPath := filepath.Join(w.imageStoreDir, previewName)
	tempPath := previewPath + ".tmp.jpg"
	_ = os.Remove(tempPath)
	if err := runVipsThumbnail(ctx, sourcePath, tempPath, w.previewLongEdge); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, previewPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	payload := task.Payload
	payload.PreviewStorageName = previewName
	payload.PreviewURL = buildImagePreviewAssetURL(previewName)
	payload.PreviewStatus = "ready"
	payload.FileURL = payload.PreviewURL
	if strings.TrimSpace(payload.OriginalStorageName) == "" {
		payload.OriginalStorageName = sourceName
	}
	payload.OriginalURL = buildImageAssetURL(payload.OriginalStorageName)
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = w.db.Exec(ctx, `
		UPDATE im_message
		SET content_payload = $1, updated_at = NOW()
		WHERE id = $2 AND message_type = 'image' AND status = 'normal'`, string(payloadBytes), task.MessageID)
	return err
}

func (w *Worker) markTaskFailed(ctx context.Context, task imageTask) error {
	payload := task.Payload
	payload.PreviewStatus = "failed"
	payload.PreviewStorageName = ""
	payload.PreviewURL = ""
	if strings.TrimSpace(payload.OriginalStorageName) == "" {
		payload.OriginalStorageName = payload.StorageName
	}
	payload.OriginalURL = buildImageAssetURL(payload.OriginalStorageName)
	payload.FileURL = payload.OriginalURL
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = w.db.Exec(ctx, `
		UPDATE im_message
		SET content_payload = $1, updated_at = NOW()
		WHERE id = $2 AND message_type = 'image' AND status = 'normal'`, string(payloadBytes), task.MessageID)
	return err
}

func runVipsThumbnail(ctx context.Context, sourcePath string, outputPath string, longEdge int) error {
	commandName, err := findVipsCommand()
	if err != nil {
		return err
	}
	if filepath.Base(commandName) == "vipsthumbnail" || strings.EqualFold(filepath.Base(commandName), "vipsthumbnail") {
		cmd := exec.CommandContext(ctx, commandName, sourcePath, "--size", strconv.Itoa(longEdge)+"x"+strconv.Itoa(longEdge), "--output", outputPath)
		return cmd.Run()
	}
	cmd := exec.CommandContext(ctx, commandName, "thumbnail", sourcePath, outputPath, strconv.Itoa(longEdge), "--size", "down")
	return cmd.Run()
}

func findVipsCommand() (string, error) {
	if path, err := exec.LookPath("vipsthumbnail"); err == nil {
		return path, nil
	}
	if path, err := exec.LookPath("vips"); err == nil {
		return path, nil
	}
	return "", errors.New("libvips command not found")
}

func generateStorageName(ext string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf) + ext, nil
}

func normalizePreviewStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "pending", "ready", "failed":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func isHEICMimeType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image/heic", "image/heif":
		return true
	default:
		return false
	}
}

func ensureAttachmentStorageName(storageName string) bool {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" || strings.Contains(normalized, "..") || strings.ContainsAny(normalized, `/\\`) {
		return false
	}
	for _, ch := range normalized {
		switch {
		case ch >= 'a' && ch <= 'z':
		case ch >= 'A' && ch <= 'Z':
		case ch >= '0' && ch <= '9':
		case ch == '.', ch == '-', ch == '_':
		default:
			return false
		}
	}
	return true
}

func ensureImageStorageName(storageName string) bool {
	if !ensureAttachmentStorageName(storageName) {
		return false
	}
	switch strings.ToLower(filepath.Ext(strings.TrimSpace(storageName))) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif":
		return true
	default:
		return false
	}
}

func buildImageAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/image/" + normalized
}

func buildImagePreviewAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/image-preview/" + normalized
}
