package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	voiceMessageMaxBytes     = 320 * 1024
	voiceMessageMaxDurationMs = 60 * 1000
)

var supportedVoiceAssetExts = map[string]string{
	".webm": "audio/webm",
	".ogg":  "audio/ogg",
}

type voiceMessageStoragePayload struct {
	StorageName string `json:"storage_name"`
	FileURL     string `json:"file_url,omitempty"`
	MimeType    string `json:"mime_type"`
	DurationMs  int    `json:"duration_ms"`
	FileSize    int    `json:"file_size"`
}

func ensureVoiceStorageName(storageName string) bool {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" || strings.Contains(normalized, "..") || strings.ContainsAny(normalized, `/\\`) {
		return false
	}
	_, ok := supportedVoiceAssetExts[strings.ToLower(filepath.Ext(normalized))]
	return ok
}

func normalizeVoiceMimeType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	if semiIndex := strings.Index(normalized, ";"); semiIndex >= 0 {
		normalized = strings.TrimSpace(normalized[:semiIndex])
	}
	switch normalized {
	case "audio/webm":
		return "audio/webm"
	case "audio/ogg":
		return "audio/ogg"
	default:
		return ""
	}
}

func detectVoiceAssetExt(filename string, mimeType string) string {
	normalizedMimeType := normalizeVoiceMimeType(mimeType)
	switch normalizedMimeType {
	case "audio/webm":
		return ".webm"
	case "audio/ogg":
		return ".ogg"
	}
	normalizedExt := strings.ToLower(strings.TrimSpace(filepath.Ext(filename)))
	if _, ok := supportedVoiceAssetExts[normalizedExt]; ok {
		return normalizedExt
	}
	return ""
}

func buildVoiceAssetURL(storageName string) string {
	normalized := strings.TrimSpace(storageName)
	if normalized == "" {
		return ""
	}
	return "/im/assets/voice/" + normalized
}

func normalizeVoiceMessagePayload(rawContent string) (voiceMessageStoragePayload, error) {
	var payload voiceMessageStoragePayload
	if err := json.Unmarshal([]byte(strings.TrimSpace(rawContent)), &payload); err != nil {
		return voiceMessageStoragePayload{}, errInvalidVoicePayload
	}
	normalizedStorageName := strings.TrimSpace(payload.StorageName)
	if !ensureVoiceStorageName(normalizedStorageName) {
		return voiceMessageStoragePayload{}, errInvalidVoicePayload
	}
	normalizedMimeType := normalizeVoiceMimeType(payload.MimeType)
	if normalizedMimeType == "" {
		normalizedMimeType = supportedVoiceAssetExts[strings.ToLower(filepath.Ext(normalizedStorageName))]
	}
	if normalizedMimeType == "" {
		return voiceMessageStoragePayload{}, errInvalidVoicePayload
	}
	durationMs := int(payload.DurationMs)
	if durationMs <= 0 || durationMs > voiceMessageMaxDurationMs {
		return voiceMessageStoragePayload{}, errInvalidVoicePayload
	}
	fileSize := int(payload.FileSize)
	if fileSize <= 0 || fileSize > voiceMessageMaxBytes {
		return voiceMessageStoragePayload{}, errInvalidVoicePayload
	}
	return voiceMessageStoragePayload{
		StorageName: normalizedStorageName,
		FileURL:     buildVoiceAssetURL(normalizedStorageName),
		MimeType:    normalizedMimeType,
		DurationMs:  durationMs,
		FileSize:    fileSize,
	}, nil
}

func formatVoiceMessagePreview(durationMs int) string {
	seconds := (durationMs + 500) / 1000
	if seconds <= 0 {
		seconds = 1
	}
	return "[语音] " + strconv.Itoa(seconds) + "″"
}

func (a *App) ensureVoiceDirectories() error {
	return os.MkdirAll(strings.TrimSpace(a.cfg.VoiceStoreDir), 0o755)
}

func (a *App) persistVoiceAsset(content []byte, ext string) (string, bool, error) {
	if len(content) == 0 {
		return "", false, errors.New("empty voice file")
	}
	hashSum := sha256.Sum256(content)
	storageName := hex.EncodeToString(hashSum[:]) + ext
	storagePath := filepath.Join(strings.TrimSpace(a.cfg.VoiceStoreDir), storageName)
	if _, err := os.Stat(storagePath); err == nil {
		return storageName, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	if err := os.WriteFile(storagePath, content, 0o644); err != nil {
		return "", false, err
	}
	return storageName, true, nil
}

func (a *App) removeVoiceAsset(storageName string) {
	if !ensureVoiceStorageName(storageName) {
		return
	}
	_ = os.Remove(filepath.Join(strings.TrimSpace(a.cfg.VoiceStoreDir), storageName))
}

func (a *App) handleSendVoiceMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := r.ParseMultipartForm(int64(voiceMessageMaxBytes + 64*1024)); err != nil {
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
	durationMs, err := strconv.Atoi(strings.TrimSpace(r.FormValue("duration_ms")))
	if err != nil || durationMs <= 0 || durationMs > voiceMessageMaxDurationMs {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid duration_ms"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing voice file"})
		return
	}
	defer file.Close()
	ext := detectVoiceAssetExt(header.Filename, header.Header.Get("Content-Type"))
	if ext == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "unsupported voice format"})
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, int64(voiceMessageMaxBytes+1)))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if len(content) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "empty voice file"})
		return
	}
	if len(content) > voiceMessageMaxBytes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "voice file too large"})
		return
	}
	normalizedMimeType := normalizeVoiceMimeType(header.Header.Get("Content-Type"))
	if normalizedMimeType == "" {
		normalizedMimeType = supportedVoiceAssetExts[ext]
	}
	storageName, created, err := a.persistVoiceAsset(content, ext)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	payloadBytes, err := json.Marshal(voiceMessageStoragePayload{
		StorageName: storageName,
		MimeType:    normalizedMimeType,
		DurationMs:  durationMs,
		FileSize:    len(content),
	})
	if err != nil {
		if created {
			a.removeVoiceAsset(storageName)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	message, err := a.insertMessage(r.Context(), conversationID, username, sendMessageRequest{
		ConversationID: conversationID,
		MessageType:    "voice",
		Content:        string(payloadBytes),
	})
	if err != nil {
		if created {
			a.removeVoiceAsset(storageName)
		}
		if errors.Is(err, errInvalidVoicePayload) || errors.Is(err, errInvalidMessageType) || errors.Is(err, errEmptyMessageContent) {
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

func (a *App) handleVoiceAssetFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	storageName := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/im/assets/voice/"))
	if !ensureVoiceStorageName(storageName) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	filePath := filepath.Join(strings.TrimSpace(a.cfg.VoiceStoreDir), storageName)
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
	mimeType := supportedVoiceAssetExts[strings.ToLower(filepath.Ext(storageName))]
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, storageName, info.ModTime(), file)
}
