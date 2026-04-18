package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sort"
	"strings"
	"time"

	"github.com/HugoSmits86/nativewebp"
	"github.com/jackc/pgx/v5"
)

const emojiAssetMaxEdge = 192

var supportedEmojiAssetExts = map[string]struct{}{
	".png":  {},
	".jpg":  {},
	".jpeg": {},
	".webp": {},
}

type EmojiAssetItem struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Code      string `json:"code"`
	WebPURL   string `json:"webp_url,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	SortOrder int    `json:"sort_order,omitempty"`
}

type emojiAssetRecord struct {
	ID          int64
	AssetKey    string
	Title       string
	Code        string
	SourceName  string
	StorageName string
	Width       int
	Height      int
	FileSize    int
	SortOrder   int
	Enabled     bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type emojiAssetManifestFile struct {
	Items []emojiAssetManifestItem `json:"items"`
}

type emojiAssetManifestItem struct {
	File      string `json:"file"`
	Title     string `json:"title"`
	Code      string `json:"code"`
	SortOrder int    `json:"sort_order"`
	Enabled   *bool  `json:"enabled,omitempty"`
}

type EmojiAssetImportItem struct {
	SourceName  string `json:"source_name"`
	StorageName string `json:"storage_name,omitempty"`
	Title       string `json:"title,omitempty"`
	Code        string `json:"code,omitempty"`
	AssetID     int64  `json:"asset_id,omitempty"`
	Status      string `json:"status"`
	Message     string `json:"message,omitempty"`
	WebPURL     string `json:"webp_url,omitempty"`
}

type EmojiAssetImportResult struct {
	ImportedCount int                    `json:"imported_count"`
	SkippedCount  int                    `json:"skipped_count"`
	FailedCount   int                    `json:"failed_count"`
	Items         []EmojiAssetImportItem `json:"items"`
}

func emojiAssetSchemaStatements() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS im_emoji_asset (
			id BIGSERIAL PRIMARY KEY,
			asset_key TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL DEFAULT '',
			code TEXT NOT NULL DEFAULT '',
			source_name TEXT NOT NULL DEFAULT '',
			storage_name TEXT NOT NULL DEFAULT '',
			width INTEGER NOT NULL DEFAULT 0,
			height INTEGER NOT NULL DEFAULT 0,
			file_size INTEGER NOT NULL DEFAULT 0,
			sort_order INTEGER NOT NULL DEFAULT 0,
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS code TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS source_name TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS storage_name TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS width INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS height INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS file_size INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
		`ALTER TABLE im_emoji_asset ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_emoji_asset_asset_key ON im_emoji_asset(asset_key)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_emoji_asset_storage_name ON im_emoji_asset(storage_name)`,
		`CREATE INDEX IF NOT EXISTS idx_im_emoji_asset_enabled_sort ON im_emoji_asset(enabled, sort_order ASC, id ASC)`,
	}
}

func (a *App) ensureEmojiDirectories() error {
	if err := os.MkdirAll(strings.TrimSpace(a.cfg.EmojiSourceDir), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(strings.TrimSpace(a.cfg.EmojiStoreDir), 0o755); err != nil {
		return err
	}
	return nil
}

func (a *App) buildEmojiAssetURL(storageName string) string {
	normalizedStorageName := strings.TrimSpace(storageName)
	if normalizedStorageName == "" {
		return ""
	}
	return "/im/assets/emoji/" + normalizedStorageName
}

func deriveEmojiAssetBaseName(sourceName string) string {
	base := strings.TrimSpace(strings.TrimSuffix(filepath.Base(sourceName), filepath.Ext(sourceName)))
	if base == "" {
		return "表情"
	}
	return base
}

func normalizeEmojiAssetText(value string, fallback string) string {
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " "))
	if normalized == "" {
		normalized = strings.TrimSpace(fallback)
	}
	if normalized == "" {
		normalized = "表情"
	}
	if len([]rune(normalized)) > 48 {
		normalized = string([]rune(normalized)[:48])
	}
	return normalized
}

func buildAutoEmojiAssetManifestItem(sourceName string, fallbackSortOrder int) emojiAssetManifestItem {
	base := strings.TrimSpace(strings.TrimSuffix(filepath.Base(sourceName), filepath.Ext(sourceName)))
	if base == "" {
		base = "表情"
	}
	sortOrder := fallbackSortOrder
	label := base
	prefixDigits := 0
	for prefixDigits < len(label) {
		ch := label[prefixDigits]
		if ch < '0' || ch > '9' {
			break
		}
		prefixDigits++
	}
	if prefixDigits > 0 {
		if parsedSortOrder, err := strconv.Atoi(label[:prefixDigits]); err == nil && parsedSortOrder > 0 {
			sortOrder = parsedSortOrder
		}
		label = strings.TrimLeft(label[prefixDigits:], " _-.")
	}
	label = strings.TrimSpace(strings.NewReplacer("_", " ", "-", " ").Replace(label))
	label = normalizeEmojiAssetText(label, base)
	return emojiAssetManifestItem{
		File:      sourceName,
		Title:     label,
		Code:      label,
		SortOrder: sortOrder,
	}
}

func isEmojiAssetSourceFile(entry os.DirEntry) bool {
	if entry == nil || entry.IsDir() {
		return false
	}
	_, ok := supportedEmojiAssetExts[strings.ToLower(filepath.Ext(entry.Name()))]
	return ok
}

func loadEmojiAssetManifest(sourceDir string) (map[string]emojiAssetManifestItem, error) {
	manifestPath := filepath.Join(strings.TrimSpace(sourceDir), "manifest.json")
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]emojiAssetManifestItem{}, nil
		}
		return nil, err
	}
	var manifest emojiAssetManifestFile
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, err
	}
	result := make(map[string]emojiAssetManifestItem, len(manifest.Items))
	for _, item := range manifest.Items {
		key := strings.ToLower(strings.TrimSpace(filepath.Base(item.File)))
		if key == "" {
			continue
		}
		result[key] = item
	}
	return result, nil
}

func decodeEmojiAssetImage(path string) (image.Image, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if strings.EqualFold(filepath.Ext(path), ".webp") {
		return nativewebp.DecodeIgnoreAlphaFlag(file)
	}
	img, _, err := image.Decode(file)
	return img, err
}

func resizeImageToMaxEdge(src image.Image, maxEdge int) image.Image {
	if src == nil || maxEdge <= 0 {
		return src
	}
	bounds := src.Bounds()
	srcWidth := bounds.Dx()
	srcHeight := bounds.Dy()
	if srcWidth <= 0 || srcHeight <= 0 {
		return src
	}
	if srcWidth <= maxEdge && srcHeight <= maxEdge {
		return src
	}
	dstWidth := srcWidth
	dstHeight := srcHeight
	if srcWidth >= srcHeight {
		dstWidth = maxEdge
		dstHeight = (srcHeight*maxEdge + srcWidth/2) / srcWidth
	} else {
		dstHeight = maxEdge
		dstWidth = (srcWidth*maxEdge + srcHeight/2) / srcHeight
	}
	if dstWidth < 1 {
		dstWidth = 1
	}
	if dstHeight < 1 {
		dstHeight = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, dstWidth, dstHeight))
	for y := 0; y < dstHeight; y++ {
		srcY := bounds.Min.Y + (y*srcHeight)/dstHeight
		if srcY >= bounds.Max.Y {
			srcY = bounds.Max.Y - 1
		}
		for x := 0; x < dstWidth; x++ {
			srcX := bounds.Min.X + (x*srcWidth)/dstWidth
			if srcX >= bounds.Max.X {
				srcX = bounds.Max.X - 1
			}
			dst.Set(x, y, src.At(srcX, srcY))
		}
	}
	return dst
}

func encodeEmojiAssetWebP(img image.Image) ([]byte, error) {
	buffer := bytes.NewBuffer(nil)
	if err := nativewebp.Encode(buffer, img, &nativewebp.Options{}); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func writeEmojiAssetBytes(path string, content []byte) error {
	if existingContent, err := os.ReadFile(path); err == nil {
		if bytes.Equal(existingContent, content) {
			return nil
		}
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, content, 0o644); err != nil {
		return err
	}
	_ = os.Remove(path)
	return os.Rename(tmpPath, path)
}

func (a *App) emojiAssetExists(ctx context.Context, assetID int64) (bool, error) {
	if assetID <= 0 {
		return false, nil
	}
	var exists bool
	err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM im_emoji_asset WHERE id = $1 AND enabled = TRUE)`, assetID).Scan(&exists)
	return exists, err
}

func (a *App) upsertEmojiAsset(ctx context.Context, record emojiAssetRecord) (emojiAssetRecord, bool, error) {
	normalized := emojiAssetRecord{
		AssetKey:    strings.TrimSpace(record.AssetKey),
		Title:       normalizeEmojiAssetText(record.Title, deriveEmojiAssetBaseName(record.SourceName)),
		Code:        normalizeEmojiAssetText(record.Code, deriveEmojiAssetBaseName(record.SourceName)),
		SourceName:  strings.TrimSpace(record.SourceName),
		StorageName: strings.TrimSpace(record.StorageName),
		Width:       record.Width,
		Height:      record.Height,
		FileSize:    record.FileSize,
		SortOrder:   record.SortOrder,
		Enabled:     record.Enabled,
	}
	if normalized.AssetKey == "" || normalized.StorageName == "" {
		return emojiAssetRecord{}, false, errors.New("invalid emoji asset record")
	}
	created := false
	err := a.db.QueryRow(ctx, `SELECT id FROM im_emoji_asset WHERE asset_key = $1`, normalized.AssetKey).Scan(new(int64))
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return emojiAssetRecord{}, false, err
		}
		created = true
	}
	var saved emojiAssetRecord
	if err := a.db.QueryRow(ctx, `
		INSERT INTO im_emoji_asset (asset_key, title, code, source_name, storage_name, width, height, file_size, sort_order, enabled, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
		ON CONFLICT (asset_key) DO UPDATE
		SET title = EXCLUDED.title,
			code = EXCLUDED.code,
			source_name = EXCLUDED.source_name,
			storage_name = EXCLUDED.storage_name,
			width = EXCLUDED.width,
			height = EXCLUDED.height,
			file_size = EXCLUDED.file_size,
			sort_order = EXCLUDED.sort_order,
			enabled = EXCLUDED.enabled,
			updated_at = NOW()
		RETURNING id, asset_key, title, code, source_name, storage_name, width, height, file_size, sort_order, enabled, created_at, updated_at`,
		normalized.AssetKey, normalized.Title, normalized.Code, normalized.SourceName, normalized.StorageName, normalized.Width, normalized.Height, normalized.FileSize, normalized.SortOrder, normalized.Enabled,
	).Scan(&saved.ID, &saved.AssetKey, &saved.Title, &saved.Code, &saved.SourceName, &saved.StorageName, &saved.Width, &saved.Height, &saved.FileSize, &saved.SortOrder, &saved.Enabled, &saved.CreatedAt, &saved.UpdatedAt); err != nil {
		return emojiAssetRecord{}, false, err
	}
	return saved, created, nil
}

func (a *App) listEmojiAssets(ctx context.Context, enabledOnly bool) ([]EmojiAssetItem, error) {
	query := `
		SELECT id, title, code, storage_name, width, height, sort_order
		FROM im_emoji_asset`
	params := []any{}
	if enabledOnly {
		query += ` WHERE enabled = TRUE`
	}
	query += ` ORDER BY sort_order ASC, id ASC`
	rows, err := a.db.Query(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]EmojiAssetItem, 0)
	for rows.Next() {
		var item EmojiAssetItem
		var storageName string
		if err := rows.Scan(&item.ID, &item.Title, &item.Code, &storageName, &item.Width, &item.Height, &item.SortOrder); err != nil {
			return nil, err
		}
		item.WebPURL = a.buildEmojiAssetURL(storageName)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (a *App) importEmojiAssets(ctx context.Context) (EmojiAssetImportResult, error) {
	result := EmojiAssetImportResult{Items: make([]EmojiAssetImportItem, 0)}
	manifest, err := loadEmojiAssetManifest(a.cfg.EmojiSourceDir)
	if err != nil {
		return result, err
	}
	entries, err := os.ReadDir(a.cfg.EmojiSourceDir)
	if err != nil {
		return result, err
	}
	sort.Slice(entries, func(left int, right int) bool {
		return strings.ToLower(entries[left].Name()) < strings.ToLower(entries[right].Name())
	})
	autoSortOrder := 0
	for _, entry := range entries {
		if !isEmojiAssetSourceFile(entry) {
			continue
		}
		autoSortOrder++
		sourceName := entry.Name()
		sourcePath := filepath.Join(a.cfg.EmojiSourceDir, sourceName)
		manifestItem, hasManifest := manifest[strings.ToLower(sourceName)]
		autoManifestItem := buildAutoEmojiAssetManifestItem(sourceName, autoSortOrder)
		if !hasManifest {
			manifestItem = autoManifestItem
		} else {
			if strings.TrimSpace(manifestItem.Title) == "" {
				manifestItem.Title = autoManifestItem.Title
			}
			if strings.TrimSpace(manifestItem.Code) == "" {
				manifestItem.Code = autoManifestItem.Code
			}
			if manifestItem.SortOrder <= 0 {
				manifestItem.SortOrder = autoManifestItem.SortOrder
			}
		}
		img, err := decodeEmojiAssetImage(sourcePath)
		if err != nil {
			result.FailedCount++
			result.Items = append(result.Items, EmojiAssetImportItem{
				SourceName: sourceName,
				Status:     "failed",
				Message:    err.Error(),
			})
			continue
		}
		resized := resizeImageToMaxEdge(img, emojiAssetMaxEdge)
		webpBytes, err := encodeEmojiAssetWebP(resized)
		if err != nil {
			result.FailedCount++
			result.Items = append(result.Items, EmojiAssetImportItem{
				SourceName: sourceName,
				Status:     "failed",
				Message:    err.Error(),
			})
			continue
		}
		hashSum := sha256.Sum256(webpBytes)
		assetKey := hex.EncodeToString(hashSum[:])
		storageName := assetKey + ".webp"
		storagePath := filepath.Join(a.cfg.EmojiStoreDir, storageName)
		if err := writeEmojiAssetBytes(storagePath, webpBytes); err != nil {
			result.FailedCount++
			result.Items = append(result.Items, EmojiAssetImportItem{
				SourceName: sourceName,
				Status:     "failed",
				Message:    err.Error(),
			})
			continue
		}
		baseName := deriveEmojiAssetBaseName(sourceName)
		enabled := true
		if hasManifest && manifestItem.Enabled != nil {
			enabled = *manifestItem.Enabled
		}
		record, created, err := a.upsertEmojiAsset(ctx, emojiAssetRecord{
			AssetKey:    assetKey,
			Title:       normalizeEmojiAssetText(manifestItem.Title, baseName),
			Code:        normalizeEmojiAssetText(manifestItem.Code, baseName),
			SourceName:  sourceName,
			StorageName: storageName,
			Width:       resized.Bounds().Dx(),
			Height:      resized.Bounds().Dy(),
			FileSize:    len(webpBytes),
			SortOrder:   manifestItem.SortOrder,
			Enabled:     enabled,
		})
		if err != nil {
			result.FailedCount++
			result.Items = append(result.Items, EmojiAssetImportItem{
				SourceName: sourceName,
				Status:     "failed",
				Message:    err.Error(),
			})
			continue
		}
		status := "skipped"
		message := "已存在，已刷新元数据"
		if created {
			status = "imported"
			message = "导入成功"
			result.ImportedCount++
		} else {
			result.SkippedCount++
		}
		result.Items = append(result.Items, EmojiAssetImportItem{
			SourceName:  sourceName,
			StorageName: record.StorageName,
			Title:       record.Title,
			Code:        record.Code,
			AssetID:     record.ID,
			Status:      status,
			Message:     message,
			WebPURL:     a.buildEmojiAssetURL(record.StorageName),
		})
	}
	return result, nil
}

func (a *App) handleEmojiAssets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if _, err := a.requireAllowedUser(r); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	items, err := a.listEmojiAssets(r.Context(), true)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) handleInternalEmojiAssetImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	if !isLoopbackRequest(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
		return
	}
	if err := a.ensureEmojiDirectories(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	result, err := a.importEmojiAssets(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":        true,
		"imported_count": result.ImportedCount,
		"skipped_count":  result.SkippedCount,
		"failed_count":   result.FailedCount,
		"items":          result.Items,
	})
}

func (a *App) handleEmojiAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	storageName := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/im/assets/emoji/"))
	if storageName == "" || strings.Contains(storageName, "..") || strings.ContainsAny(storageName, `/\\`) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	filePath := filepath.Join(a.cfg.EmojiStoreDir, storageName)
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
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, storageName, info.ModTime(), file)
}

func (a *App) loadBootstrapEmojiAssets(ctx context.Context) []EmojiAssetItem {
	items, err := a.listEmojiAssets(ctx, true)
	if err != nil {
		log.Printf("load bootstrap emoji assets failed: %v", err)
		return []EmojiAssetItem{}
	}
	return items
}
