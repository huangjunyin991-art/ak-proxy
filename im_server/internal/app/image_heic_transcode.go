package app

import (
	"bytes"
	"errors"
	"image"
	"io"
	"path/filepath"
	"strings"

	"github.com/gen2brain/heic"
)

type persistedImageAsset struct {
	StorageName string
	FileSize    int
	FileName    string
	MimeType    string
}

func isHEICImageExt(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case ".heic", ".heif":
		return true
	default:
		return false
	}
}

func buildStoredImageFileName(fileName string, ext string) string {
	normalizedExt := sanitizeAttachmentExt("image"+ext, ".jpg")
	normalizedName := sanitizeAttachmentFileName(fileName, "image"+normalizedExt)
	baseName := strings.TrimSpace(strings.TrimSuffix(normalizedName, filepath.Ext(normalizedName)))
	if baseName == "" || baseName == "." || baseName == ".." {
		baseName = "image"
	}
	return baseName + normalizedExt
}

func readUploadedImageBytes(reader io.Reader, maxBytes int64) ([]byte, error) {
	content, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) == 0 {
		return nil, errors.New("empty file")
	}
	if int64(len(content)) > maxBytes {
		return nil, errors.New("file too large")
	}
	return content, nil
}

func decodeHEICImage(reader io.Reader) (image.Image, error) {
	img, err := heic.Decode(reader)
	if err != nil {
		return nil, errors.New("failed to decode heic image")
	}
	if img == nil {
		return nil, errors.New("failed to decode heic image")
	}
	return img, nil
}

func transcodeHEICImageToWebP(reader io.Reader, maxBytes int64, maxLongEdgePx int) ([]byte, error) {
	content, err := readUploadedImageBytes(reader, maxBytes)
	if err != nil {
		return nil, err
	}
	img, err := decodeHEICImage(bytes.NewReader(content))
	if err != nil {
		return nil, err
	}
	if maxLongEdgePx > 0 {
		img = resizeImageToMaxEdge(img, maxLongEdgePx)
	}
	webpBytes, err := encodeEmojiAssetWebP(img)
	if err != nil {
		return nil, err
	}
	if len(webpBytes) == 0 {
		return nil, errors.New("empty file")
	}
	if int64(len(webpBytes)) > maxBytes {
		return nil, errors.New("file too large")
	}
	return webpBytes, nil
}

func writeUploadedBytes(destPath string, content []byte, maxBytes int64) (int64, error) {
	return writeUploadedFile(destPath, bytes.NewReader(content), maxBytes)
}
