package app

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const videoMessageMaxBytes = 500 * 1024 * 1024

var supportedVideoInputExts = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".mkv":  "video/x-matroska",
	".avi":  "video/x-msvideo",
	".mpeg": "video/mpeg",
	".mpg":  "video/mpeg",
}

type videoMessageStoragePayload struct {
	StorageName      string `json:"storage_name"`
	VideoURL         string `json:"video_url,omitempty"`
	PosterName       string `json:"poster_name,omitempty"`
	PosterURL        string `json:"poster_url,omitempty"`
	FileName         string `json:"file_name"`
	MimeType         string `json:"mime_type"`
	FileSize         int    `json:"file_size"`
	OriginalMimeType string `json:"original_mime_type,omitempty"`
	Width            int    `json:"width,omitempty"`
	Height           int    `json:"height,omitempty"`
	DurationMs       int    `json:"duration_ms,omitempty"`
}

type persistedVideoAsset struct {
	StorageName      string
	PosterName       string
	FileName         string
	MimeType         string
	FileSize         int
	OriginalMimeType string
}

func normalizeVideoMimeType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	if semiIndex := strings.Index(normalized, ";"); semiIndex >= 0 {
		normalized = strings.TrimSpace(normalized[:semiIndex])
	}
	switch normalized {
	case "video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo", "video/mpeg":
		return normalized
	default:
		if strings.HasPrefix(normalized, "video/") {
			return normalized
		}
		return ""
	}
}

func detectVideoAssetExt(filename string, mimeType string) string {
	normalizedMimeType := normalizeVideoMimeType(mimeType)
	if normalizedMimeType != "" {
		for ext, supportedMimeType := range supportedVideoInputExts {
			if supportedMimeType == normalizedMimeType {
				return ext
			}
		}
	}
	normalizedExt := strings.ToLower(strings.TrimSpace(filepath.Ext(strings.TrimSpace(filename))))
	if _, ok := supportedVideoInputExts[normalizedExt]; ok {
		return normalizedExt
	}
	return ""
}

func ensureVideoStorageName(storageName string) bool {
	if !ensureAttachmentStorageName(storageName) {
		return false
	}
	return strings.ToLower(filepath.Ext(strings.TrimSpace(storageName))) == ".mp4"
}

func ensureVideoPosterStorageName(storageName string) bool {
	if !ensureAttachmentStorageName(storageName) {
		return false
	}
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(storageName)))
	return ext == ".jpg" || ext == ".jpeg"
}

func buildVideoAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/video/" + normalized
}

func buildVideoPosterAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/video-poster/" + normalized
}

func normalizeVideoMessagePayload(rawContent string) (videoMessageStoragePayload, error) {
	var payload videoMessageStoragePayload
	if err := json.Unmarshal([]byte(strings.TrimSpace(rawContent)), &payload); err != nil {
		return videoMessageStoragePayload{}, errInvalidVideoPayload
	}
	normalizedStorageName := strings.TrimSpace(payload.StorageName)
	if !ensureVideoStorageName(normalizedStorageName) {
		return videoMessageStoragePayload{}, errInvalidVideoPayload
	}
	fileName := sanitizeAttachmentFileName(payload.FileName, "video.mp4")
	fileSize := int(payload.FileSize)
	if fileSize <= 0 || fileSize > videoMessageMaxBytes {
		return videoMessageStoragePayload{}, errInvalidVideoPayload
	}
	posterName := strings.TrimSpace(payload.PosterName)
	if posterName != "" && !ensureVideoPosterStorageName(posterName) {
		posterName = ""
	}
	return videoMessageStoragePayload{
		StorageName:      normalizedStorageName,
		VideoURL:         buildVideoAssetURL(normalizedStorageName),
		PosterName:       posterName,
		PosterURL:        buildVideoPosterAssetURL(posterName),
		FileName:         fileName,
		MimeType:         "video/mp4",
		FileSize:         fileSize,
		OriginalMimeType: normalizeVideoMimeType(payload.OriginalMimeType),
		Width:            payload.Width,
		Height:           payload.Height,
		DurationMs:       payload.DurationMs,
	}, nil
}

func formatVideoMessagePreview(fileName string) string {
	normalized := strings.TrimSpace(fileName)
	if normalized == "" {
		return "[视频]"
	}
	return "[视频] " + normalized
}

func (a *App) ensureVideoDirectories() error {
	return os.MkdirAll(strings.TrimSpace(a.cfg.VideoStoreDir), 0o755)
}

func (a *App) persistVideoAsset(inputPath string, fileName string, originalMimeType string) (persistedVideoAsset, error) {
	storageName, err := generateAttachmentStorageName(".mp4")
	if err != nil {
		return persistedVideoAsset{}, err
	}
	baseName := strings.TrimSuffix(storageName, filepath.Ext(storageName))
	posterName := baseName + ".jpg"
	outputPath := filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), storageName)
	posterPath := filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), posterName)
	if isVideoFastRemuxCompatible(inputPath) {
		if err := remuxVideoFastStart(inputPath, outputPath); err != nil {
			_ = os.Remove(outputPath)
			if err := transcodeVideoTo720p(inputPath, outputPath); err != nil {
				a.removeVideoAsset(storageName, posterName)
				return persistedVideoAsset{}, err
			}
		}
	} else {
		if err := transcodeVideoTo720p(inputPath, outputPath); err != nil {
			a.removeVideoAsset(storageName, posterName)
			return persistedVideoAsset{}, err
		}
	}
	_ = generateVideoPoster(outputPath, posterPath)
	info, err := os.Stat(outputPath)
	if err != nil {
		a.removeVideoAsset(storageName, posterName)
		return persistedVideoAsset{}, err
	}
	if _, err := os.Stat(posterPath); err != nil {
		posterName = ""
	}
	return persistedVideoAsset{
		StorageName:      storageName,
		PosterName:       posterName,
		FileName:         buildStoredVideoFileName(fileName),
		MimeType:         "video/mp4",
		FileSize:         int(info.Size()),
		OriginalMimeType: normalizeVideoMimeType(originalMimeType),
	}, nil
}

func buildStoredVideoFileName(fileName string) string {
	normalized := sanitizeAttachmentFileName(fileName, "video.mp4")
	base := strings.TrimSuffix(normalized, filepath.Ext(normalized))
	base = strings.TrimSpace(base)
	if base == "" {
		base = "video"
	}
	return base + ".mp4"
}

func transcodeVideoTo720p(inputPath string, outputPath string) error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return errors.New("服务器暂不支持视频压缩")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-i", inputPath, "-map", "0:v:0", "-map", "0:a?", "-vf", "scale=-2:trunc(min(720\\,ih)/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		log.Printf("im video transcode failed input=%s output=%s error=%v ffmpeg=%s", filepath.Base(inputPath), filepath.Base(outputPath), err, truncateVideoCommandOutput(output))
		if ctx.Err() == context.DeadlineExceeded {
			return errors.New("视频压缩超时")
		}
		return errors.New("视频压缩失败")
	}
	return nil
}

func remuxVideoFastStart(inputPath string, outputPath string) error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return errors.New("服务器暂不支持视频压缩")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-i", inputPath, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", outputPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		log.Printf("im video remux failed input=%s output=%s error=%v ffmpeg=%s", filepath.Base(inputPath), filepath.Base(outputPath), err, truncateVideoCommandOutput(output))
		if ctx.Err() == context.DeadlineExceeded {
			return errors.New("视频封装超时")
		}
		return errors.New("视频封装失败")
	}
	return nil
}

func truncateVideoCommandOutput(output []byte) string {
	text := strings.TrimSpace(string(output))
	if len(text) <= 1200 {
		return text
	}
	return text[len(text)-1200:]
}

func isVideoFastRemuxCompatible(inputPath string) bool {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt", "-of", "default=noprint_wrappers=1", inputPath)
	output, err := cmd.CombinedOutput()
	if err != nil || ctx.Err() != nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(string(output)))
	return strings.Contains(text, "codec_name=h264") && strings.Contains(text, "pix_fmt=yuv420p")
}

func generateVideoPoster(inputPath string, posterPath string) error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-ss", "00:00:00.001", "-i", inputPath, "-vframes", "1", "-vf", "scale=480:-2", posterPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return errors.New("video poster timeout")
		}
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return errors.New(message)
	}
	return nil
}

func (a *App) removeVideoAsset(storageName string, posterName string) {
	if ensureVideoStorageName(storageName) {
		_ = os.Remove(filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), storageName))
	}
	if ensureVideoPosterStorageName(posterName) {
		_ = os.Remove(filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), posterName))
	}
}

func (a *App) handleSendVideoMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
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
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing video file"})
		return
	}
	defer file.Close()
	ext := detectVideoAssetExt(header.Filename, header.Header.Get("Content-Type"))
	if ext == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "unsupported video format"})
		return
	}
	originalMimeType := normalizeVideoMimeType(header.Header.Get("Content-Type"))
	if originalMimeType == "" {
		originalMimeType = normalizeVideoMimeType(mime.TypeByExtension(ext))
	}
	tempName, err := generateAttachmentStorageName(".upload" + ext)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	tempPath := filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), tempName)
	if _, err := writeUploadedFile(tempPath, file, int64(videoMessageMaxBytes)); err != nil {
		_ = os.Remove(tempPath)
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	defer os.Remove(tempPath)
	asset, err := a.persistVideoAsset(tempPath, header.Filename, originalMimeType)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
		return
	}
	payloadBytes, err := json.Marshal(videoMessageStoragePayload{
		StorageName:      asset.StorageName,
		PosterName:       asset.PosterName,
		FileName:         asset.FileName,
		MimeType:         asset.MimeType,
		FileSize:         asset.FileSize,
		OriginalMimeType: asset.OriginalMimeType,
	})
	if err != nil {
		a.removeVideoAsset(asset.StorageName, asset.PosterName)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	clientTempID := strings.TrimSpace(r.FormValue("client_temp_id"))
	message, err := a.insertMessage(r.Context(), conversationID, username, sendMessageRequest{
		ConversationID: conversationID,
		MessageType:    "video",
		Content:        string(payloadBytes),
		ClientTempID:   clientTempID,
	})
	if err != nil {
		a.removeVideoAsset(asset.StorageName, asset.PosterName)
		if isGroupMuteSendError(err) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error(), "restriction": "group_mute"})
			return
		}
		if errors.Is(err, errInvalidVideoPayload) || errors.Is(err, errInvalidMessageType) || errors.Is(err, errEmptyMessageContent) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	a.broadcastMessageCreated(r.Context(), conversationID, message)
	writeJSON(w, http.StatusOK, map[string]any{"item": message})
}

func (a *App) handleVideoAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	storageName := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/im/assets/video/"))
	if !ensureVideoStorageName(storageName) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if !a.authorizeMessageAssetRequest(w, r, storageName, "storage_name") {
		return
	}
	filePath := filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), storageName)
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
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	http.ServeContent(w, r, storageName, info.ModTime(), file)
}

func (a *App) handleVideoPosterAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	storageName := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/im/assets/video-poster/"))
	if !ensureVideoPosterStorageName(storageName) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if !a.authorizeMessageAssetRequest(w, r, storageName, "poster_name") {
		return
	}
	filePath := filepath.Join(strings.TrimSpace(a.cfg.VideoStoreDir), storageName)
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
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	http.ServeContent(w, r, storageName, info.ModTime(), file)
}
