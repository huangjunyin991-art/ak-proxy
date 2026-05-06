package media

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"im_server/internal/media/loadguard"
	"im_server/internal/media/preview"
	"im_server/internal/media/taskstore"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultScanInterval           = 5 * time.Second
	defaultBatchSize              = 8
	defaultPreviewEdge            = 1920
	defaultBackfillPreviewEdge    = 1280
	defaultBackfillEnqueueLimit   = 4
	defaultBackfillMinFileSize    = 128 * 1024
	defaultPreviewGenerateTimeout = 3 * time.Minute
)

type Worker struct {
	db                      *pgxpool.Pool
	tasks                   *taskstore.Store
	guard                   *loadguard.Guard
	generator               preview.VipsGenerator
	backfillGenerator       preview.VipsGenerator
	imageStoreDir           string
	scanInterval            time.Duration
	batchSize               int
	previewLongEdge         int
	backfillPreviewLongEdge int
	backfillEnqueueLimit    int
	backfillMinFileSize     int
}

type Config struct {
	DatabaseURL             string
	ImageStoreDir           string
	ScanInterval            time.Duration
	BatchSize               int
	PreviewLongEdge         int
	BackfillPreviewLongEdge int
	BackfillEnqueueLimit    int
	BackfillMinFileSize     int
	ReserveCPUPercent       int
	MemoryHighWaterPercent  int
	MinAvailableMemoryMB    int
	MaxConcurrency          int
}

type imageTask struct {
	MessageID      int64
	ConversationID int64
	Payload        imagePayload
	TaskID         int64
	MediaKind      string
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
		db:                      pool,
		tasks:                   taskstore.New(pool),
		imageStoreDir:           strings.TrimSpace(cfg.ImageStoreDir),
		scanInterval:            cfg.ScanInterval,
		batchSize:               cfg.BatchSize,
		previewLongEdge:         cfg.PreviewLongEdge,
		backfillPreviewLongEdge: cfg.BackfillPreviewLongEdge,
		backfillEnqueueLimit:    cfg.BackfillEnqueueLimit,
		backfillMinFileSize:     cfg.BackfillMinFileSize,
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
	if worker.backfillPreviewLongEdge <= 0 {
		worker.backfillPreviewLongEdge = defaultBackfillPreviewEdge
	}
	if worker.backfillEnqueueLimit <= 0 {
		worker.backfillEnqueueLimit = defaultBackfillEnqueueLimit
	}
	if worker.backfillMinFileSize <= 0 {
		worker.backfillMinFileSize = defaultBackfillMinFileSize
	}
	if worker.imageStoreDir == "" {
		worker.imageStoreDir = "./data/im/image_assets"
	}
	worker.generator = preview.VipsGenerator{LongEdge: worker.previewLongEdge}
	worker.backfillGenerator = preview.VipsGenerator{LongEdge: worker.backfillPreviewLongEdge}
	worker.guard = loadguard.New(loadguard.Config{
		ReserveCPUPercent:      cfg.ReserveCPUPercent,
		MemoryHighWaterPercent: cfg.MemoryHighWaterPercent,
		MinAvailableBytes:      uint64(maxInt(0, cfg.MinAvailableMemoryMB)) * 1024 * 1024,
		MaxConcurrency:         cfg.MaxConcurrency,
	})
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
	if err := w.generator.EnsureAvailable(); err != nil {
		return err
	}
	if err := os.MkdirAll(w.imageStoreDir, 0o755); err != nil {
		return err
	}
	if w.tasks != nil {
		if err := w.tasks.EnsureSchema(ctx); err != nil {
			return err
		}
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
	for handled := 0; handled < w.batchSize; {
		snapshot := w.guard.AllowedSlots(1)
		if snapshot.AllowedSlots <= 0 {
			if snapshot.BlockedReason != "" {
				log.Printf("media worker throttled: reason=%s cpu=%.1f mem=%.1f available_mb=%d", snapshot.BlockedReason, snapshot.CPUUsagePercent, snapshot.MemoryUsagePercent, snapshot.AvailableMemoryBytes/1024/1024)
			}
			return nil
		}
		taskHandled, err := w.processTaskStoreTasks(ctx, 1)
		if err != nil {
			return err
		}
		if taskHandled > 0 {
			handled += taskHandled
			releaseWorkerMemory()
			continue
		}
		legacyHandled, err := w.processLegacyPendingMessages(ctx, 1)
		if err != nil {
			return err
		}
		if legacyHandled > 0 {
			handled += legacyHandled
			releaseWorkerMemory()
			continue
		}
		enqueued, err := w.enqueueBackfillPreviewTasks(ctx)
		if err != nil {
			return err
		}
		if enqueued <= 0 {
			return nil
		}
	}
	return nil
}

func (w *Worker) processTaskStoreTasks(ctx context.Context, limit int) (int, error) {
	if w.tasks == nil || limit <= 0 {
		return 0, nil
	}
	tasks, err := w.tasks.ClaimPendingTasks(ctx, limit)
	if err != nil {
		return 0, err
	}
	handled := 0
	for _, task := range tasks {
		handled++
		if task.MessageID <= 0 || strings.TrimSpace(task.SourceStorageName) == "" {
			_ = w.tasks.MarkFailed(ctx, task.ID, "invalid media preview task")
			continue
		}
		imageTask, err := w.loadMessageTask(ctx, task.MessageID, task.MediaKind)
		if err != nil {
			log.Printf("media worker load task failed: task_id=%d message_id=%d err=%v", task.ID, task.MessageID, err)
			_ = w.tasks.MarkFailed(ctx, task.ID, err.Error())
			continue
		}
		imageTask.TaskID = task.ID
		imageTask.MediaKind = task.MediaKind
		if strings.TrimSpace(imageTask.Payload.OriginalStorageName) == "" {
			imageTask.Payload.OriginalStorageName = task.SourceStorageName
		}
		if err := w.markTaskProcessing(ctx, imageTask); err != nil {
			log.Printf("media worker mark processing failed: task_id=%d message_id=%d err=%v", task.ID, task.MessageID, err)
		}
		previewName, err := w.processTask(ctx, imageTask)
		if err != nil {
			log.Printf("media worker task failed: task_id=%d message_id=%d err=%v", task.ID, task.MessageID, err)
			_ = w.markTaskFailed(ctx, imageTask)
			_ = w.tasks.MarkFailed(ctx, task.ID, err.Error())
			continue
		}
		if err := w.tasks.MarkReady(ctx, task.ID, previewName); err != nil {
			log.Printf("media worker mark ready failed: task_id=%d err=%v", task.ID, err)
		}
	}
	return handled, nil
}

func (w *Worker) processLegacyPendingMessages(ctx context.Context, limit int) (int, error) {
	tasks, err := w.loadPendingTasks(ctx, limit)
	if err != nil {
		return 0, err
	}
	handled := 0
	for _, task := range tasks {
		handled++
		if _, err := w.processTask(ctx, task); err != nil {
			log.Printf("media worker legacy task failed: message_id=%d err=%v", task.MessageID, err)
			_ = w.markTaskFailed(ctx, task)
		}
	}
	return handled, nil
}

func (w *Worker) enqueueBackfillPreviewTasks(ctx context.Context) (int64, error) {
	if w == nil || w.tasks == nil || w.backfillEnqueueLimit <= 0 {
		return 0, nil
	}
	return w.tasks.EnqueueImageBackfillPreviewTasks(ctx, w.backfillEnqueueLimit, w.backfillMinFileSize)
}

func releaseWorkerMemory() {
	debug.FreeOSMemory()
}

func (w *Worker) loadMessageTask(ctx context.Context, messageID int64, mediaKind string) (imageTask, error) {
	var task imageTask
	var rawPayload string
	if err := w.db.QueryRow(ctx, `
		SELECT id, conversation_id, content_payload
		FROM im_message
		WHERE id = $1
			AND message_type = 'image'
			AND status = 'normal'
			AND deleted_at IS NULL`, messageID).Scan(&task.MessageID, &task.ConversationID, &rawPayload); err != nil {
		return imageTask{}, err
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(rawPayload)), &task.Payload); err != nil {
		return imageTask{}, err
	}
	task.MediaKind = strings.TrimSpace(mediaKind)
	if !canProcessPreviewTaskMime(task.MediaKind, task.Payload.MimeType) {
		return imageTask{}, errors.New("unsupported media preview task mime type")
	}
	return task, nil
}

func (w *Worker) loadPendingTasks(ctx context.Context, limit int) ([]imageTask, error) {
	if limit <= 0 {
		return []imageTask{}, nil
	}
	rows, err := w.db.Query(ctx, `
		SELECT m.id, m.conversation_id, m.content_payload
		FROM im_message m
		WHERE m.message_type = 'image'
			AND m.status = 'normal'
			AND m.deleted_at IS NULL
			AND m.content_payload::jsonb ->> 'preview_status' = 'pending'
			AND m.content_payload::jsonb ->> 'mime_type' IN ('image/heic', 'image/heif')
			AND NOT EXISTS (
				SELECT 1 FROM im_media_preview_task t
				WHERE t.message_id = m.id
					AND t.status IN ('pending', 'processing', 'ready', 'failed')
			)
		ORDER BY m.id ASC
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]imageTask, 0, limit)
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
		task.MediaKind = taskstore.KindImageHEICPreview
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (w *Worker) processTask(ctx context.Context, task imageTask) (string, error) {
	sourceName := strings.TrimSpace(task.Payload.OriginalStorageName)
	if sourceName == "" {
		sourceName = strings.TrimSpace(task.Payload.StorageName)
	}
	if !ensureImageStorageName(sourceName) {
		return "", errors.New("invalid source image storage name")
	}
	sourcePath := filepath.Join(w.imageStoreDir, sourceName)
	if _, err := os.Stat(sourcePath); err != nil {
		return "", err
	}
	generator := w.generatorForTask(task)
	previewName, err := generateStorageName(".jpg")
	if err != nil {
		return "", err
	}
	previewPath := filepath.Join(w.imageStoreDir, previewName)
	tempPath := previewPath + ".tmp.jpg"
	_ = os.Remove(tempPath)
	generateCtx, cancel := context.WithTimeout(ctx, defaultPreviewGenerateTimeout)
	defer cancel()
	if err := generator.Generate(generateCtx, sourcePath, tempPath); err != nil {
		_ = os.Remove(tempPath)
		return "", err
	}
	if err := os.Rename(tempPath, previewPath); err != nil {
		_ = os.Remove(tempPath)
		return "", err
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
		return "", err
	}
	_, err = w.db.Exec(ctx, `
		UPDATE im_message
		SET content_payload = $1, updated_at = NOW()
		WHERE id = $2 AND message_type = 'image' AND status = 'normal'`, string(payloadBytes), task.MessageID)
	if err != nil {
		return "", err
	}
	return previewName, nil
}

func (w *Worker) markTaskProcessing(ctx context.Context, task imageTask) error {
	payload := task.Payload
	payload.PreviewStatus = "processing"
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

func generateStorageName(ext string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf) + ext, nil
}

func normalizePreviewStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "pending", "processing", "ready", "failed":
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

func isBackfillPreviewMimeType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func canProcessPreviewTaskMime(mediaKind string, mimeType string) bool {
	switch strings.TrimSpace(mediaKind) {
	case taskstore.KindImageHEICPreview:
		return isHEICMimeType(mimeType)
	case taskstore.KindImageBackfillPreview:
		return isBackfillPreviewMimeType(mimeType)
	default:
		return false
	}
}

func (w *Worker) generatorForTask(task imageTask) preview.VipsGenerator {
	if strings.TrimSpace(task.MediaKind) == taskstore.KindImageBackfillPreview {
		return w.backfillGenerator
	}
	return w.generator
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

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
