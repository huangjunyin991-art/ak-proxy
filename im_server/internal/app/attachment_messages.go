package app

import (
	"context"
	cryptoRand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	imageMessageMaxBytes        = 20 * 1024 * 1024
	fileMessageMaxBytes         = 200 * 1024 * 1024
	defaultFileAssetRetentionDays = 30
	defaultImageCompressAboveKB = 512
	defaultImageMaxLongEdgePx   = 1920
	defaultImageQuality         = 82
	defaultImageTargetSizeKB    = 1024
	fileAssetCleanupBatchSize   = 24
	fileAssetCleanupInterval    = time.Hour
	imFileAssetConfigKey        = "file_asset_config"
	imImageUploadConfigKey      = "image_upload_config"
)

var supportedImageAssetExts = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".gif":  "image/gif",
	".heic": "image/heic",
	".heif": "image/heif",
}

type imageMessageStoragePayload struct {
	StorageName string `json:"storage_name"`
	FileURL     string `json:"file_url,omitempty"`
	FileName    string `json:"file_name,omitempty"`
	MimeType    string `json:"mime_type"`
	FileSize    int    `json:"file_size"`
	Source      string `json:"source,omitempty"`
}

type fileMessageStoragePayload struct {
	StorageName string `json:"storage_name"`
	FileURL     string `json:"file_url,omitempty"`
	FileName    string `json:"file_name"`
	MimeType    string `json:"mime_type"`
	FileSize    int    `json:"file_size"`
	ExpiresAt   string `json:"expires_at"`
	Expired     bool   `json:"expired,omitempty"`
}

type fileAssetConfigSnapshot struct {
	RetentionDays int `json:"retention_days"`
}

type imageUploadConfigSnapshot struct {
	Enabled           bool   `json:"enabled"`
	CompressAboveKB   int    `json:"compress_above_kb"`
	MaxLongEdgePx     int    `json:"max_long_edge_px"`
	OutputFormat      string `json:"output_format"`
	Quality           int    `json:"quality"`
	TargetSizeKB      int    `json:"target_size_kb"`
	KeepPNGWithAlpha  bool   `json:"keep_png_with_alpha"`
	SkipAnimatedGIF   bool   `json:"skip_animated_gif"`
}

type storedFileAssetRecord struct {
	StorageName string
	FileName    string
	MimeType    string
	FileSize    int64
	ExpiresAt   time.Time
	Status      string
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
	_, ok := supportedImageAssetExts[strings.ToLower(filepath.Ext(strings.TrimSpace(storageName)))]
	return ok
}

func ensureFileStorageName(storageName string) bool {
	return ensureAttachmentStorageName(storageName)
}

func sanitizeAttachmentFileName(value string, fallback string) string {
	normalized := strings.TrimSpace(filepath.Base(strings.TrimSpace(value)))
	if normalized == "" || normalized == "." || normalized == ".." {
		normalized = strings.TrimSpace(fallback)
	}
	normalized = strings.Map(func(r rune) rune {
		if r == 0 || r < 32 {
			return -1
		}
		return r
	}, normalized)
	normalized = strings.TrimSpace(normalized)
	if normalized == "" || normalized == "." || normalized == ".." {
		normalized = strings.TrimSpace(fallback)
	}
	if normalized == "" {
		normalized = "attachment.bin"
	}
	return normalized
}

func sanitizeAttachmentExt(fileName string, fallback string) string {
	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(strings.TrimSpace(fileName))))
	if ext == "" {
		ext = strings.TrimSpace(fallback)
	}
	if ext == "" || len(ext) > 24 {
		return ".bin"
	}
	for _, ch := range ext {
		if ch == '.' {
			continue
		}
		if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') {
			continue
		}
		return ".bin"
	}
	return ext
}

func normalizeImageMimeType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	if semiIndex := strings.Index(normalized, ";"); semiIndex >= 0 {
		normalized = strings.TrimSpace(normalized[:semiIndex])
	}
	switch normalized {
	case "image/jpeg", "image/jpg":
		return "image/jpeg"
	case "image/png":
		return "image/png"
	case "image/webp":
		return "image/webp"
	case "image/gif":
		return "image/gif"
	case "image/heic":
		return "image/heic"
	case "image/heif":
		return "image/heif"
	default:
		return ""
	}
}

func normalizeFileMimeType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	if semiIndex := strings.Index(normalized, ";"); semiIndex >= 0 {
		normalized = strings.TrimSpace(normalized[:semiIndex])
	}
	return normalized
}

func detectImageAssetExt(filename string, mimeType string) string {
	normalizedMimeType := normalizeImageMimeType(mimeType)
	if normalizedMimeType != "" {
		for ext, supportedMimeType := range supportedImageAssetExts {
			if supportedMimeType == normalizedMimeType {
				return ext
			}
		}
	}
	normalizedExt := strings.ToLower(strings.TrimSpace(filepath.Ext(strings.TrimSpace(filename))))
	if _, ok := supportedImageAssetExts[normalizedExt]; ok {
		return normalizedExt
	}
	return ""
}

func sanitizeImageSource(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "camera":
		return "camera"
	case "album":
		return "album"
	default:
		return "album"
	}
}

func generateAttachmentStorageName(ext string) (string, error) {
	buf := make([]byte, 16)
	if _, err := cryptoRand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf) + sanitizeAttachmentExt("asset"+ext, ".bin"), nil
}

func buildImageAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/image/" + normalized
}

func buildFileAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/file/" + normalized
}

func normalizeImageMessagePayload(rawContent string) (imageMessageStoragePayload, error) {
	var payload imageMessageStoragePayload
	if err := json.Unmarshal([]byte(strings.TrimSpace(rawContent)), &payload); err != nil {
		return imageMessageStoragePayload{}, errInvalidImagePayload
	}
	normalizedStorageName := strings.TrimSpace(payload.StorageName)
	if !ensureImageStorageName(normalizedStorageName) {
		return imageMessageStoragePayload{}, errInvalidImagePayload
	}
	normalizedMimeType := normalizeImageMimeType(payload.MimeType)
	if normalizedMimeType == "" {
		normalizedMimeType = supportedImageAssetExts[strings.ToLower(filepath.Ext(normalizedStorageName))]
	}
	if normalizedMimeType == "" {
		return imageMessageStoragePayload{}, errInvalidImagePayload
	}
	fileName := sanitizeAttachmentFileName(payload.FileName, "image"+filepath.Ext(normalizedStorageName))
	fileSize := int(payload.FileSize)
	if fileSize <= 0 || fileSize > imageMessageMaxBytes {
		return imageMessageStoragePayload{}, errInvalidImagePayload
	}
	return imageMessageStoragePayload{
		StorageName: normalizedStorageName,
		FileURL:     buildImageAssetURL(normalizedStorageName),
		FileName:    fileName,
		MimeType:    normalizedMimeType,
		FileSize:    fileSize,
		Source:      sanitizeImageSource(payload.Source),
	}, nil
}

func normalizeStoredFileMessagePayload(rawContent string) (fileMessageStoragePayload, error) {
	var payload fileMessageStoragePayload
	if err := json.Unmarshal([]byte(strings.TrimSpace(rawContent)), &payload); err != nil {
		return fileMessageStoragePayload{}, errInvalidFilePayload
	}
	normalizedStorageName := strings.TrimSpace(payload.StorageName)
	if !ensureFileStorageName(normalizedStorageName) {
		return fileMessageStoragePayload{}, errInvalidFilePayload
	}
	normalizedMimeType := normalizeFileMimeType(payload.MimeType)
	if normalizedMimeType == "" {
		normalizedMimeType = normalizeFileMimeType(mime.TypeByExtension(strings.ToLower(filepath.Ext(normalizedStorageName))))
	}
	if normalizedMimeType == "" {
		normalizedMimeType = "application/octet-stream"
	}
	fileName := sanitizeAttachmentFileName(payload.FileName, "attachment"+filepath.Ext(normalizedStorageName))
	fileSize := int(payload.FileSize)
	if fileSize <= 0 || fileSize > fileMessageMaxBytes {
		return fileMessageStoragePayload{}, errInvalidFilePayload
	}
	expiresAtText := strings.TrimSpace(payload.ExpiresAt)
	expiresAt, err := time.Parse(time.RFC3339, expiresAtText)
	if err != nil || expiresAt.IsZero() {
		return fileMessageStoragePayload{}, errInvalidFilePayload
	}
	return fileMessageStoragePayload{
		StorageName: normalizedStorageName,
		FileURL:     buildFileAssetURL(normalizedStorageName),
		FileName:    fileName,
		MimeType:    normalizedMimeType,
		FileSize:    fileSize,
		ExpiresAt:   expiresAt.UTC().Format(time.RFC3339),
		Expired:     payload.Expired,
	}, nil
}

func formatImageMessagePreview() string {
	return "[图片]"
}

func formatFileMessagePreview(fileName string) string {
	normalized := strings.TrimSpace(fileName)
	if normalized == "" {
		return "[文件]"
	}
	return "[文件] " + normalized
}

func normalizeFileAssetRetentionDays(value int) int {
	if value <= 0 {
		return defaultFileAssetRetentionDays
	}
	if value > 3650 {
		return 3650
	}
	return value
}

func defaultImageUploadConfigSnapshot() imageUploadConfigSnapshot {
	return imageUploadConfigSnapshot{
		Enabled:          true,
		CompressAboveKB:  defaultImageCompressAboveKB,
		MaxLongEdgePx:    defaultImageMaxLongEdgePx,
		OutputFormat:     "jpeg",
		Quality:          defaultImageQuality,
		TargetSizeKB:     defaultImageTargetSizeKB,
		KeepPNGWithAlpha: true,
		SkipAnimatedGIF:  true,
	}
}

func normalizeImageUploadOutputFormat(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "keep":
		return "keep"
	case "webp":
		return "webp"
	default:
		return "jpeg"
	}
}

func normalizeImageCompressAboveKB(value int) int {
	if value < 0 {
		return 0
	}
	maxValue := imageMessageMaxBytes / 1024
	if value > maxValue {
		return maxValue
	}
	return value
}

func normalizeImageMaxLongEdgePx(value int) int {
	if value < 320 {
		return 320
	}
	if value > 4096 {
		return 4096
	}
	return value
}

func normalizeImageQuality(value int) int {
	if value < 40 {
		return 40
	}
	if value > 95 {
		return 95
	}
	return value
}

func normalizeImageTargetSizeKB(value int) int {
	if value < 64 {
		return 64
	}
	maxValue := imageMessageMaxBytes / 1024
	if value > maxValue {
		return maxValue
	}
	return value
}

func normalizeImageUploadConfigSnapshot(snapshot imageUploadConfigSnapshot) imageUploadConfigSnapshot {
	defaults := defaultImageUploadConfigSnapshot()
	snapshot.Enabled = snapshot.Enabled
	snapshot.CompressAboveKB = normalizeImageCompressAboveKB(snapshot.CompressAboveKB)
	snapshot.MaxLongEdgePx = normalizeImageMaxLongEdgePx(snapshot.MaxLongEdgePx)
	snapshot.OutputFormat = normalizeImageUploadOutputFormat(snapshot.OutputFormat)
	snapshot.Quality = normalizeImageQuality(snapshot.Quality)
	snapshot.TargetSizeKB = normalizeImageTargetSizeKB(snapshot.TargetSizeKB)
	if strings.TrimSpace(snapshot.OutputFormat) == "" {
		snapshot.OutputFormat = defaults.OutputFormat
	}
	return snapshot
}

func (a *App) getSystemConfigValue(ctx context.Context, key string) (string, error) {
	var value string
	err := a.db.QueryRow(ctx, `SELECT value_json FROM im_system_config WHERE key = $1`, strings.TrimSpace(key)).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return value, nil
}

func (a *App) setSystemConfigValue(ctx context.Context, key string, value string) error {
	_, err := a.db.Exec(ctx, `
		INSERT INTO im_system_config (key, value_json, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
		strings.TrimSpace(key), strings.TrimSpace(value),
	)
	return err
}

func (a *App) getFileAssetConfig(ctx context.Context) (fileAssetConfigSnapshot, error) {
	snapshot := fileAssetConfigSnapshot{RetentionDays: defaultFileAssetRetentionDays}
	raw, err := a.getSystemConfigValue(ctx, imFileAssetConfigKey)
	if err != nil || strings.TrimSpace(raw) == "" {
		return snapshot, err
	}
	var stored fileAssetConfigSnapshot
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return snapshot, nil
	}
	snapshot.RetentionDays = normalizeFileAssetRetentionDays(stored.RetentionDays)
	return snapshot, nil
}

func (a *App) setFileAssetConfig(ctx context.Context, snapshot fileAssetConfigSnapshot) (fileAssetConfigSnapshot, error) {
	snapshot.RetentionDays = normalizeFileAssetRetentionDays(snapshot.RetentionDays)
	payloadBytes, err := json.Marshal(snapshot)
	if err != nil {
		return snapshot, err
	}
	if err := a.setSystemConfigValue(ctx, imFileAssetConfigKey, string(payloadBytes)); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}

func (a *App) getImageUploadConfig(ctx context.Context) (imageUploadConfigSnapshot, error) {
	snapshot := defaultImageUploadConfigSnapshot()
	raw, err := a.getSystemConfigValue(ctx, imImageUploadConfigKey)
	if err != nil || strings.TrimSpace(raw) == "" {
		return snapshot, err
	}
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		return defaultImageUploadConfigSnapshot(), nil
	}
	return normalizeImageUploadConfigSnapshot(snapshot), nil
}

func (a *App) setImageUploadConfig(ctx context.Context, snapshot imageUploadConfigSnapshot) (imageUploadConfigSnapshot, error) {
	snapshot = normalizeImageUploadConfigSnapshot(snapshot)
	payloadBytes, err := json.Marshal(snapshot)
	if err != nil {
		return snapshot, err
	}
	if err := a.setSystemConfigValue(ctx, imImageUploadConfigKey, string(payloadBytes)); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}

func writeUploadedFile(destPath string, reader io.Reader, maxBytes int64) (int64, error) {
	destFile, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(destFile, io.LimitReader(reader, maxBytes+1))
	closeErr := destFile.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return 0, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return 0, closeErr
	}
	if written <= 0 {
		_ = os.Remove(destPath)
		return 0, errors.New("empty file")
	}
	if written > maxBytes {
		_ = os.Remove(destPath)
		return 0, errors.New("file too large")
	}
	return written, nil
}

func (a *App) ensureImageDirectories() error {
	return os.MkdirAll(strings.TrimSpace(a.cfg.ImageStoreDir), 0o755)
}

func (a *App) ensureFileDirectories() error {
	return os.MkdirAll(strings.TrimSpace(a.cfg.FileStoreDir), 0o755)
}

func (a *App) persistHEICImageAsset(reader io.Reader, fileName string, config imageUploadConfigSnapshot) (persistedImageAsset, error) {
	storageName, err := generateAttachmentStorageName(".webp")
	if err != nil {
		return persistedImageAsset{}, err
	}
	storagePath := filepath.Join(strings.TrimSpace(a.cfg.ImageStoreDir), storageName)
	webpBytes, err := transcodeHEICImageToWebP(reader, int64(imageMessageMaxBytes), config.MaxLongEdgePx)
	if err != nil {
		return persistedImageAsset{}, err
	}
	written, err := writeUploadedBytes(storagePath, webpBytes, int64(imageMessageMaxBytes))
	if err != nil {
		return persistedImageAsset{}, err
	}
	return persistedImageAsset{
		StorageName: storageName,
		FileSize:    int(written),
		FileName:    buildStoredImageFileName(fileName, ".webp"),
		MimeType:    "image/webp",
	}, nil
}

func (a *App) persistImageAsset(reader io.Reader, fileName string, ext string, config imageUploadConfigSnapshot) (persistedImageAsset, error) {
	normalizedExt := detectImageAssetExt("image"+ext, "")
	if normalizedExt == "" {
		return persistedImageAsset{}, errors.New("unsupported image format")
	}
	if isHEICImageExt(normalizedExt) {
		return a.persistHEICImageAsset(reader, fileName, config)
	}
	storageName, err := generateAttachmentStorageName(normalizedExt)
	if err != nil {
		return persistedImageAsset{}, err
	}
	storagePath := filepath.Join(strings.TrimSpace(a.cfg.ImageStoreDir), storageName)
	written, err := writeUploadedFile(storagePath, reader, int64(imageMessageMaxBytes))
	if err != nil {
		return persistedImageAsset{}, err
	}
	return persistedImageAsset{
		StorageName: storageName,
		FileSize:    int(written),
		FileName:    sanitizeAttachmentFileName(fileName, "image"+normalizedExt),
		MimeType:    supportedImageAssetExts[normalizedExt],
	}, nil
}

func (a *App) persistFileAsset(reader io.Reader, ext string) (string, int, error) {
	normalizedExt := sanitizeAttachmentExt("file"+ext, ".bin")
	storageName, err := generateAttachmentStorageName(normalizedExt)
	if err != nil {
		return "", 0, err
	}
	storagePath := filepath.Join(strings.TrimSpace(a.cfg.FileStoreDir), storageName)
	written, err := writeUploadedFile(storagePath, reader, int64(fileMessageMaxBytes))
	if err != nil {
		return "", 0, err
	}
	return storageName, int(written), nil
}

func (a *App) removeImageAsset(storageName string) {
	if !ensureImageStorageName(storageName) {
		return
	}
	_ = os.Remove(filepath.Join(strings.TrimSpace(a.cfg.ImageStoreDir), storageName))
}

func (a *App) removeFileAssetFile(storageName string) {
	if !ensureFileStorageName(storageName) {
		return
	}
	_ = os.Remove(filepath.Join(strings.TrimSpace(a.cfg.FileStoreDir), storageName))
}

func (a *App) saveFileAssetRecord(ctx context.Context, record storedFileAssetRecord) error {
	_, err := a.db.Exec(ctx, `
		INSERT INTO im_file_asset (storage_name, original_name, mime_type, file_size, expires_at, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
		ON CONFLICT (storage_name) DO UPDATE SET
			original_name = EXCLUDED.original_name,
			mime_type = EXCLUDED.mime_type,
			file_size = EXCLUDED.file_size,
			expires_at = EXCLUDED.expires_at,
			status = 'active',
			deleted_at = NULL,
			updated_at = NOW()`,
		strings.TrimSpace(record.StorageName),
		sanitizeAttachmentFileName(record.FileName, "attachment.bin"),
		normalizeFileMimeType(record.MimeType),
		record.FileSize,
		record.ExpiresAt.UTC(),
	)
	return err
}

func (a *App) deleteFileAssetRecord(ctx context.Context, storageName string) error {
	_, err := a.db.Exec(ctx, `DELETE FROM im_file_asset WHERE storage_name = $1`, strings.TrimSpace(storageName))
	return err
}

func (a *App) loadFileAssetRecord(ctx context.Context, storageName string) (storedFileAssetRecord, error) {
	var record storedFileAssetRecord
	err := a.db.QueryRow(ctx, `
		SELECT storage_name, original_name, mime_type, file_size, expires_at, status
		FROM im_file_asset
		WHERE storage_name = $1`, strings.TrimSpace(storageName),
	).Scan(&record.StorageName, &record.FileName, &record.MimeType, &record.FileSize, &record.ExpiresAt, &record.Status)
	if err != nil {
		return storedFileAssetRecord{}, err
	}
	return record, nil
}

func (a *App) markFileAssetStatus(ctx context.Context, storageName string, status string) error {
	_, err := a.db.Exec(ctx, `
		UPDATE im_file_asset
		SET status = $2, deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
		WHERE storage_name = $1`, strings.TrimSpace(storageName), strings.TrimSpace(status),
	)
	return err
}

func (a *App) expireFileAsset(ctx context.Context, storageName string) error {
	a.removeFileAssetFile(storageName)
	return a.markFileAssetStatus(ctx, storageName, "expired")
}

func (a *App) markFileAssetMissing(ctx context.Context, storageName string) error {
	return a.markFileAssetStatus(ctx, storageName, "missing")
}

func (a *App) cleanupExpiredFileAssets(ctx context.Context, limit int) error {
	if limit <= 0 {
		limit = fileAssetCleanupBatchSize
	}
	rows, err := a.db.Query(ctx, `
		SELECT storage_name
		FROM im_file_asset
		WHERE deleted_at IS NULL AND status = 'active' AND expires_at <= NOW()
		ORDER BY expires_at ASC
		LIMIT $1`, limit,
	)
	if err != nil {
		return err
	}
	defer rows.Close()
	storageNames := make([]string, 0, limit)
	for rows.Next() {
		var storageName string
		if scanErr := rows.Scan(&storageName); scanErr != nil {
			return scanErr
		}
		storageNames = append(storageNames, storageName)
	}
	var firstErr error
	for _, storageName := range storageNames {
		if expireErr := a.expireFileAsset(ctx, storageName); expireErr != nil && firstErr == nil {
			firstErr = expireErr
		}
	}
	return firstErr
}

func (a *App) runExpiredFileAssetCleanupLoop() {
	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_ = a.cleanupExpiredFileAssets(ctx, fileAssetCleanupBatchSize)
	}
	runOnce()
	ticker := time.NewTicker(fileAssetCleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

func (a *App) hydrateFileMessagePayload(ctx context.Context, rawContent string) (fileMessageStoragePayload, error) {
	payload, err := normalizeStoredFileMessagePayload(rawContent)
	if err != nil {
		return fileMessageStoragePayload{}, err
	}
	expired := payload.Expired
	record, recordErr := a.loadFileAssetRecord(ctx, payload.StorageName)
	if recordErr == nil {
		if strings.TrimSpace(record.FileName) != "" {
			payload.FileName = sanitizeAttachmentFileName(record.FileName, payload.FileName)
		}
		if normalizedMimeType := normalizeFileMimeType(record.MimeType); normalizedMimeType != "" {
			payload.MimeType = normalizedMimeType
		}
		if record.FileSize > 0 {
			payload.FileSize = int(record.FileSize)
		}
		if !record.ExpiresAt.IsZero() {
			payload.ExpiresAt = record.ExpiresAt.UTC().Format(time.RFC3339)
			if time.Now().After(record.ExpiresAt) {
				expired = true
				_ = a.expireFileAsset(ctx, payload.StorageName)
			}
		}
		if status := strings.ToLower(strings.TrimSpace(record.Status)); status != "" && status != "active" {
			expired = true
		}
	} else if errors.Is(recordErr, pgx.ErrNoRows) {
		expired = true
	} else {
		return fileMessageStoragePayload{}, recordErr
	}
	if !expired {
		if _, statErr := os.Stat(filepath.Join(strings.TrimSpace(a.cfg.FileStoreDir), payload.StorageName)); statErr != nil {
			expired = true
			_ = a.markFileAssetMissing(ctx, payload.StorageName)
		}
	}
	payload.Expired = expired
	if expired {
		payload.FileURL = ""
	} else {
		payload.FileURL = buildFileAssetURL(payload.StorageName)
	}
	return payload, nil
}

func (a *App) normalizeOutgoingMessageItem(ctx context.Context, item MessageItem) MessageItem {
	switch strings.ToLower(strings.TrimSpace(item.MessageType)) {
	case "voice":
		payload, err := normalizeVoiceMessagePayload(item.Content)
		if err != nil {
			return item
		}
		if payloadBytes, marshalErr := json.Marshal(payload); marshalErr == nil {
			item.Content = string(payloadBytes)
		}
	case "image":
		payload, err := normalizeImageMessagePayload(item.Content)
		if err != nil {
			return item
		}
		if payloadBytes, marshalErr := json.Marshal(payload); marshalErr == nil {
			item.Content = string(payloadBytes)
		}
	case "file":
		payload, err := a.hydrateFileMessagePayload(ctx, item.Content)
		if err != nil {
			return item
		}
		if payloadBytes, marshalErr := json.Marshal(payload); marshalErr == nil {
			item.Content = string(payloadBytes)
		}
	case "location":
		payload, err := normalizeLocationMessagePayload(item.Content)
		if err != nil {
			return item
		}
		if payloadBytes, marshalErr := json.Marshal(payload); marshalErr == nil {
			item.Content = string(payloadBytes)
		}
	}
	return item
}

func buildDownloadContentDisposition(fileName string) string {
	normalizedFileName := sanitizeAttachmentFileName(fileName, "attachment.bin")
	asciiFileName := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '"' || r == '\\' {
			return '_'
		}
		if r > 126 {
			return '_'
		}
		return r
	}, normalizedFileName)
	asciiFileName = strings.TrimSpace(asciiFileName)
	if asciiFileName == "" {
		asciiFileName = "attachment.bin"
	}
	return `attachment; filename="` + asciiFileName + `"; filename*=UTF-8''` + neturl.PathEscape(normalizedFileName)
}

func (a *App) handleSendImageMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := r.ParseMultipartForm(int64(imageMessageMaxBytes + 64*1024)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid multipart payload"})
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	conversationIDText := strings.TrimSpace(r.FormValue("conversation_id"))
	conversationID, err := strconv.ParseInt(conversationIDText, 10, 64)
	if err != nil || conversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	if !a.ensureConversationMember(r.Context(), conversationIDText, username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing image file"})
		return
	}
	defer file.Close()
	ext := detectImageAssetExt(header.Filename, header.Header.Get("Content-Type"))
	if ext == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "unsupported image format"})
		return
	}
	normalizedMimeType := normalizeImageMimeType(header.Header.Get("Content-Type"))
	if normalizedMimeType == "" {
		normalizedMimeType = supportedImageAssetExts[ext]
	}
	uploadConfig := defaultImageUploadConfigSnapshot()
	if isHEICImageExt(ext) {
		uploadConfig, err = a.getImageUploadConfig(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
	}
	asset, err := a.persistImageAsset(file, header.Filename, ext, uploadConfig)
	if err != nil {
		messageText := err.Error()
		if messageText == "file too large" {
			messageText = "image file too large"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": messageText})
		return
	}
	storageName := asset.StorageName
	fileSize := asset.FileSize
	if strings.TrimSpace(asset.MimeType) != "" {
		normalizedMimeType = asset.MimeType
	}
	fileName := sanitizeAttachmentFileName(header.Filename, "image"+ext)
	if strings.TrimSpace(asset.FileName) != "" {
		fileName = sanitizeAttachmentFileName(asset.FileName, fileName)
	}
	payloadBytes, err := json.Marshal(imageMessageStoragePayload{
		StorageName: storageName,
		FileName:    fileName,
		MimeType:    normalizedMimeType,
		FileSize:    fileSize,
		Source:      sanitizeImageSource(r.FormValue("source")),
	})
	if err != nil {
		a.removeImageAsset(storageName)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	clientTempID := strings.TrimSpace(r.FormValue("client_temp_id"))
	message, err := a.insertMessage(r.Context(), conversationID, username, sendMessageRequest{
		ConversationID: conversationID,
		MessageType:    "image",
		Content:        string(payloadBytes),
		ClientTempID:   clientTempID,
	})
	if err != nil {
		a.removeImageAsset(storageName)
		if isGroupMuteSendError(err) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error(), "restriction": "group_mute"})
			return
		}
		if errors.Is(err, errInvalidImagePayload) || errors.Is(err, errInvalidMessageType) || errors.Is(err, errEmptyMessageContent) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(conversationID, map[string]any{
		"type":    "im.message.created",
		"payload": message,
	})
	writeJSON(w, http.StatusOK, map[string]any{"item": message})
}

func (a *App) handleSendFileMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := r.ParseMultipartForm(int64(fileMessageMaxBytes + 64*1024)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid multipart payload"})
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	conversationIDText := strings.TrimSpace(r.FormValue("conversation_id"))
	conversationID, err := strconv.ParseInt(conversationIDText, 10, 64)
	if err != nil || conversationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid conversation_id"})
		return
	}
	if !a.ensureConversationMember(r.Context(), conversationIDText, username) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	configSnapshot, err := a.getFileAssetConfig(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing file"})
		return
	}
	defer file.Close()
	fileName := sanitizeAttachmentFileName(header.Filename, "attachment.bin")
	ext := sanitizeAttachmentExt(fileName, ".bin")
	normalizedMimeType := normalizeFileMimeType(header.Header.Get("Content-Type"))
	if normalizedMimeType == "" {
		normalizedMimeType = normalizeFileMimeType(mime.TypeByExtension(ext))
	}
	if normalizedMimeType == "" {
		normalizedMimeType = "application/octet-stream"
	}
	storageName, fileSize, err := a.persistFileAsset(file, ext)
	if err != nil {
		messageText := err.Error()
		if messageText == "file too large" {
			messageText = "file too large"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": messageText})
		return
	}
	expiresAt := time.Now().Add(time.Duration(configSnapshot.RetentionDays) * 24 * time.Hour).UTC()
	if err := a.saveFileAssetRecord(r.Context(), storedFileAssetRecord{
		StorageName: storageName,
		FileName:    fileName,
		MimeType:    normalizedMimeType,
		FileSize:    int64(fileSize),
		ExpiresAt:   expiresAt,
	}); err != nil {
		a.removeFileAssetFile(storageName)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	payloadBytes, err := json.Marshal(fileMessageStoragePayload{
		StorageName: storageName,
		FileName:    fileName,
		MimeType:    normalizedMimeType,
		FileSize:    fileSize,
		ExpiresAt:   expiresAt.Format(time.RFC3339),
	})
	if err != nil {
		a.removeFileAssetFile(storageName)
		_ = a.deleteFileAssetRecord(r.Context(), storageName)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	message, err := a.insertMessage(r.Context(), conversationID, username, sendMessageRequest{
		ConversationID: conversationID,
		MessageType:    "file",
		Content:        string(payloadBytes),
	})
	if err != nil {
		a.removeFileAssetFile(storageName)
		_ = a.deleteFileAssetRecord(r.Context(), storageName)
		if isGroupMuteSendError(err) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error(), "restriction": "group_mute"})
			return
		}
		if errors.Is(err, errInvalidFilePayload) || errors.Is(err, errInvalidMessageType) || errors.Is(err, errEmptyMessageContent) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastConversation(conversationID, map[string]any{
		"type":    "im.message.created",
		"payload": message,
	})
	writeJSON(w, http.StatusOK, map[string]any{"item": message})
}

func (a *App) handleImageAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	storageName := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/im/assets/image/"))
	if !ensureImageStorageName(storageName) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	filePath := filepath.Join(strings.TrimSpace(a.cfg.ImageStoreDir), storageName)
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	mimeType := supportedImageAssetExts[strings.ToLower(filepath.Ext(storageName))]
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, storageName, info.ModTime(), file)
}

func (a *App) handleFileAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	storageName := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/im/assets/file/"))
	if !ensureFileStorageName(storageName) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	record, err := a.loadFileAssetRecord(r.Context(), storageName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if status := strings.ToLower(strings.TrimSpace(record.Status)); status != "" && status != "active" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if !record.ExpiresAt.IsZero() && time.Now().After(record.ExpiresAt) {
		_ = a.expireFileAsset(r.Context(), storageName)
		w.WriteHeader(http.StatusNotFound)
		return
	}
	filePath := filepath.Join(strings.TrimSpace(a.cfg.FileStoreDir), storageName)
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			_ = a.markFileAssetMissing(r.Context(), storageName)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	mimeType := normalizeFileMimeType(record.MimeType)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", buildDownloadContentDisposition(record.FileName))
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	http.ServeContent(w, r, record.FileName, info.ModTime(), file)
}

func (a *App) handleInternalFileAssetConfig(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		snapshot, err := a.getFileAssetConfig(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "retention_days": snapshot.RetentionDays})
	case http.MethodPost:
		var req fileAssetConfigSnapshot
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		if req.RetentionDays <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid retention_days"})
			return
		}
		snapshot, err := a.setFileAssetConfig(r.Context(), req)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "retention_days": snapshot.RetentionDays})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
	}
}

func (a *App) handleImageUploadConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if _, err := a.requireAllowedUser(r); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	snapshot, err := a.getImageUploadConfig(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"enabled": snapshot.Enabled,
		"compress_above_kb": snapshot.CompressAboveKB,
		"max_long_edge_px": snapshot.MaxLongEdgePx,
		"output_format": snapshot.OutputFormat,
		"quality": snapshot.Quality,
		"target_size_kb": snapshot.TargetSizeKB,
		"keep_png_with_alpha": snapshot.KeepPNGWithAlpha,
		"skip_animated_gif": snapshot.SkipAnimatedGIF,
	})
}

func (a *App) handleInternalImageUploadConfig(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		snapshot, err := a.getImageUploadConfig(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"enabled": snapshot.Enabled,
			"compress_above_kb": snapshot.CompressAboveKB,
			"max_long_edge_px": snapshot.MaxLongEdgePx,
			"output_format": snapshot.OutputFormat,
			"quality": snapshot.Quality,
			"target_size_kb": snapshot.TargetSizeKB,
			"keep_png_with_alpha": snapshot.KeepPNGWithAlpha,
			"skip_animated_gif": snapshot.SkipAnimatedGIF,
		})
	case http.MethodPost:
		req := defaultImageUploadConfigSnapshot()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid payload"})
			return
		}
		snapshot, err := a.setImageUploadConfig(r.Context(), req)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"enabled": snapshot.Enabled,
			"compress_above_kb": snapshot.CompressAboveKB,
			"max_long_edge_px": snapshot.MaxLongEdgePx,
			"output_format": snapshot.OutputFormat,
			"quality": snapshot.Quality,
			"target_size_kb": snapshot.TargetSizeKB,
			"keep_png_with_alpha": snapshot.KeepPNGWithAlpha,
			"skip_animated_gif": snapshot.SkipAnimatedGIF,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
	}
}
