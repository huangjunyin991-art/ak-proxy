package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"io"
	"net/http"
	"path/filepath"
	"strings"
)

const (
	avatarUploadMaxBytes = 10 * 1024 * 1024
	avatarMaxLongEdgePx  = 512
)

func decodeProfileAvatarImage(fileName string, ext string, content []byte) (image.Image, error) {
	if isHEICImageExt(ext) {
		return decodeHEICImage(bytes.NewReader(content))
	}
	return decodeEmojiAssetImageData(fileName, content)
}

func (a *App) persistProfileAvatarImage(reader io.Reader, fileName string, ext string) (string, error) {
	content, err := readUploadedImageBytes(reader, int64(avatarUploadMaxBytes))
	if err != nil {
		return "", err
	}
	img, err := decodeProfileAvatarImage(fileName, ext, content)
	if err != nil {
		return "", err
	}
	resized := resizeImageToMaxEdge(img, avatarMaxLongEdgePx)
	webpBytes, err := encodeEmojiAssetWebP(resized)
	if err != nil {
		return "", err
	}
	if len(webpBytes) == 0 {
		return "", errors.New("empty file")
	}
	if len(webpBytes) > avatarUploadMaxBytes {
		return "", errors.New("file too large")
	}
	hashSum := sha256.Sum256(webpBytes)
	storageName := "avatar_" + hex.EncodeToString(hashSum[:]) + ".webp"
	storagePath := filepath.Join(strings.TrimSpace(a.cfg.ImageStoreDir), storageName)
	if _, err := writeUploadedBytes(storagePath, webpBytes, int64(avatarUploadMaxBytes)); err != nil {
		return "", err
	}
	return buildImageAssetURL(storageName), nil
}

func (a *App) updateUserProfileAvatarURL(ctx context.Context, username string, avatarURL string) (UserProfileItem, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	normalizedURL := strings.TrimSpace(avatarURL)
	if normalizedUsername == "" {
		return UserProfileItem{}, errors.New("invalid username")
	}
	if normalizedURL == "" {
		return UserProfileItem{}, errors.New("invalid avatar_url")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return UserProfileItem{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO im_user_profile (username, avatar_style, avatar_seed, avatar_url, updated_at)
		VALUES ($1, $2, '', $3, NOW())
		ON CONFLICT (username) DO UPDATE
		SET avatar_style = EXCLUDED.avatar_style,
			avatar_seed = '',
			avatar_url = EXCLUDED.avatar_url,
			updated_at = NOW()`, normalizedUsername, defaultAvatarStyle, normalizedURL); err != nil {
		return UserProfileItem{}, err
	}
	if _, err := a.insertUserAvatarHistory(ctx, tx, normalizedUsername, defaultAvatarStyle, "", normalizedURL); err != nil {
		return UserProfileItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserProfileItem{}, err
	}
	return a.buildUserProfileItem(ctx, normalizedUsername), nil
}

func (a *App) handleProfileAvatarUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": true})
		return
	}
	username, err := a.requireAllowedUser(r)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": err.Error()})
		return
	}
	if err := r.ParseMultipartForm(int64(avatarUploadMaxBytes + 64*1024)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "invalid multipart payload"})
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "missing avatar file"})
		return
	}
	defer file.Close()
	ext := detectImageAssetExt(header.Filename, header.Header.Get("Content-Type"))
	if ext == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": "unsupported image format"})
		return
	}
	avatarURL, err := a.persistProfileAvatarImage(file, header.Filename, ext)
	if err != nil {
		messageText := err.Error()
		if messageText == "file too large" {
			messageText = "avatar file too large"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": true, "message": messageText})
		return
	}
	item, err := a.updateUserProfileAvatarURL(r.Context(), username, avatarURL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": true, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item})
}
